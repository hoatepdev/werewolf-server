import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { Phase, Player, PlayerSelfView } from '../types';
import { RoomService } from './room.service';
import { PushNotificationService } from './push-notification.service';
import {
  GameEngine,
  GameState,
  RoleResponse,
  NightDeathResult,
  VotingResult,
  TimerInfo,
  VotingChoice,
} from './game-engine';

type VotingResponseKind = 'target' | 'abstain' | 'timeout';

export interface PlayerVotingState {
  hasResponded: boolean;
  choice: VotingChoice | null;
  targetId: string | null;
  targetName: string | null;
}

export interface VotingProgressPayload {
  votedCount: number;
  respondedCount: number;
  totalVoters: number;
}

export interface VotingSubmissionAck {
  success: boolean;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  message?: string;
  votingState?: PlayerVotingState;
  progress?: VotingProgressPayload;
}

export interface NightPromptSnapshot {
  type: 'werewolf' | 'seer' | 'witch' | 'bodyguard' | 'hunter' | 'cupid';
  message: string;
  candidates?: Array<{ id: string; username: string }>;
  werewolves?: Array<{ id: string; username: string }>;
  killedPlayerId?: string;
  canHeal?: boolean;
  canPoison?: boolean;
  alivePlayerIds?: Array<{ id: string; username: string }>;
  lastProtected?: string;
  minSelections?: number;
  maxSelections?: number;
}

export interface PlayerStateSnapshot {
  roomCode: string;
  serverTime: number;
  phase: Phase | null;
  round: number;
  gameStarted: boolean;
  playerId: string;
  role?: Player['role'];
  alive: boolean | null;
  players: PlayerSelfView[];
  timer?: TimerInfo;
  nightPrompt?: NightPromptSnapshot | null;
  hunterDeathShooting?: boolean;
  voting?: {
    progress?: VotingProgressPayload;
    state?: PlayerVotingState;
    result?: VotingResultPayload;
  };
  winner?: 'villagers' | 'werewolves' | 'tanner';
  gameLog?: GameState['gameLog'];
  loverPartner?: { id: string; username: string } | null;
}

export interface GmStateSnapshot {
  roomCode: string;
  serverTime: number;
  phase: Phase | null;
  round: number;
  gameStarted: boolean;
  players: Player[];
  timer?: TimerInfo;
  gmActionLog: GameState['gmActionLog'];
  winner?: 'villagers' | 'werewolves' | 'tanner';
  lovers?: [string, string];
}

interface VotingResultPayload {
  gameLog?: GameState['gameLog'];
  round: number;
  eliminatedPlayerId: string | null;
  eliminatedPlayerName: string | null;
  cause: 'vote' | 'hunter' | 'tie' | 'no_votes';
  tiedPlayerIds?: string[];
  additionalDeaths?: Array<{ playerId: string; playerName: string; cause: 'lover' }>;
  tiedPlayers?: Array<{ id: string; username: string }>;
  votes: Array<{
    voterId: string;
    voterName: string;
    targetId: string | null;
    targetName: string | null;
    kind: VotingResponseKind;
  }>;
  totals: Array<{ targetId: string; targetName: string; count: number }>;
  abstainCount: number;
  timeoutCount: number;
  targetVoteCount: number;
  votedCount: number;
  respondedCount: number;
  totalVoters: number;
}

@Injectable()
export class PhaseManager {
  private readonly logger = new Logger(PhaseManager.name);
  private gameStates = new Map<string, GameState>();
  private server: Server;
  private pendingResponses = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      responses: Array<{ playerId: string; payload: RoleResponse }>;
      responded: Set<string>;
      rolePlayers: Array<{ id: string; username: string; role?: string }>;
      role: string;
      event: string;
      promptData: unknown;
      deadline: number;
      durationMs: number;
    }
  >();
  private transitionLocks = new Set<string>();
  private roomGenerations = new Map<string, number>();

  private readonly ROLE_TIMEOUTS: Record<string, number> =
    process.env.NODE_ENV === 'test'
      ? { cupid: 100, bodyguard: 100, werewolf: 100, witch: 100, seer: 100 }
      : { cupid: 30000, bodyguard: 15000, werewolf: 60000, witch: 30000, seer: 15000 };

  protected delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      timeout.unref?.();
    });

  constructor(
    private readonly roomService: RoomService,
    private readonly pushNotificationService?: PushNotificationService,
  ) {}

  setServer(server: Server) {
    this.server = server;
  }

  private delay(ms: number) {
    return this.delayFn(ms);
  }

  private getRoomGeneration(roomId: string): number {
    return this.roomGenerations.get(roomId) ?? 0;
  }

  private bumpRoomGeneration(roomId: string): number {
    const next = this.getRoomGeneration(roomId) + 1;
    this.roomGenerations.set(roomId, next);
    return next;
  }

  private isCurrentGeneration(roomId: string, generation: number): boolean {
    return this.getRoomGeneration(roomId) === generation;
  }

  /**
   * Simulates a role action for a dead or absent role.
   * Waits a random 5-10 seconds to prevent timing-based information leaks.
   */
  private async simulateDeadRoleAction(): Promise<void> {
    const fakeDelayMs = Math.floor(Math.random() * 5000) + 5000; // 5000-10000ms
    await this.delay(fakeDelayMs);
  }

  // --- Transition lock ---

  private readonly LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute failsafe
  private lockTimeouts = new Map<string, NodeJS.Timeout>();

  private acquireTransitionLock(roomId: string): boolean {
    if (this.transitionLocks.has(roomId)) return false;
    this.transitionLocks.add(roomId);
    // Failsafe: auto-release after timeout to prevent permanent lock on crash
    const t = setTimeout(() => {
      this.transitionLocks.delete(roomId);
      this.lockTimeouts.delete(roomId);
      this.logger.warn(
        `Transition lock for room ${roomId} force-released after timeout`,
      );
    }, this.LOCK_TIMEOUT_MS);
    t.unref?.();
    this.lockTimeouts.set(roomId, t);
    return true;
  }

  private releaseTransitionLock(roomId: string): void {
    this.transitionLocks.delete(roomId);
    const t = this.lockTimeouts.get(roomId);
    if (t) {
      clearTimeout(t);
      this.lockTimeouts.delete(roomId);
    }
  }

  // --- Public phase accessor ---

  getPhase(roomId: string): Phase | null {
    const state = this.gameStates.get(roomId);
    return state ? state.phase : null;
  }

  canTransition(roomId: string, targetPhase: Phase): boolean {
    const state = this.gameStates.get(roomId);
    if (!state) return false;
    if (this.transitionLocks.has(roomId)) return false;
    return GameEngine.canTransition(state, targetPhase);
  }

  getTimerInfo(roomId: string): TimerInfo | undefined {
    const state = this.gameStates.get(roomId);
    return state?.timerInfo;
  }

  getVotingProgress(roomId: string): VotingProgressPayload | undefined {
    const state = this.gameStates.get(roomId);
    if (!state || state.phase !== 'voting') return undefined;
    return this.buildVotingProgress(state);
  }

  private serializePublicPlayer(player: Player): PlayerSelfView {
    const {
      persistentId: _persistentId,
      role: _role,
      pushTokens: _pushTokens,
      ...publicPlayer
    } = player;
    return publicPlayer;
  }

  private serializePlayerForSocket(
    player: Player,
    socketId: string,
  ): PlayerSelfView {
    const publicPlayer = this.serializePublicPlayer(player);
    if (player.id !== socketId || !player.role) return publicPlayer;
    return { ...publicPlayer, role: player.role };
  }

  private serializePlayersForSocket(
    players: Player[],
    socketId: string,
  ): PlayerSelfView[] {
    return players.map((player) =>
      this.serializePlayerForSocket(player, socketId),
    );
  }

  // --- Emit helpers ---

  private appendGmActionLog(roomId: string, event: string, payload?: any): void {
    const typeByEvent: Record<
      string,
      GameState['gmActionLog'][number]['type']
    > = {
      'gm:nightAction': 'nightAction',
      'gm:votingAction': 'votingAction',
      'gm:hunterAction': 'hunterAction',
      'gm:gameEnded': 'gameEnded',
    };
    const type = typeByEvent[event];
    if (!type || typeof payload?.message !== 'string') return;

    const state = this.gameStates.get(roomId);
    if (!state) return;

    state.gmActionLog.push({
      type,
      message: payload.message,
      timestamp:
        typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      step: typeof payload.step === 'string' ? payload.step : undefined,
      action: typeof payload.action === 'string' ? payload.action : undefined,
      winner: payload.winner,
    });

    if (state.gmActionLog.length > 50) {
      state.gmActionLog.splice(0, state.gmActionLog.length - 50);
    }
  }

  private emitToGM(roomId: string, gmRoomId: string, event: string, payload?: any): void {
    if (gmRoomId) {
      this.appendGmActionLog(roomId, event, payload);
      this.server.to(gmRoomId).emit(event, payload);
    }
  }

  emitGmLog(roomId: string, event: string, payload?: any): void {
    const state = this.gameStates.get(roomId);
    const gmRoomId = state?.gmRoomId ?? this.roomService.getGmRoomId(roomId);
    if (!gmRoomId) return;

    this.appendGmActionLog(roomId, event, payload);
    this.server.to(gmRoomId).emit(event, payload);
  }

  private emitToAllPlayers(roomId: string, event: string, payload?: any): void {
    this.server.to(roomId).emit(event, payload);
  }

  private sendPush(
    roomId: string,
    tokens: string[],
    title: string,
    body: string,
    data: Record<string, string | undefined>,
  ): void {
    if (!this.pushNotificationService || tokens.length === 0) return;

    void this.pushNotificationService
      .sendToTokens(tokens, { title, body, data })
      .then(({ invalidTokens }) => {
        if (invalidTokens.length > 0) {
          this.roomService.removeInvalidPushTokens(roomId, invalidTokens);
        }
      })
      .catch((error) => {
        this.logger.warn(`Push notification failed: ${String(error)}`);
      });
  }

  private notifyPlayers(
    roomId: string,
    playerIds: string[],
    title: string,
    body: string,
    data: Record<string, string | undefined>,
  ): void {
    const tokens = this.roomService.getPushTokensForPlayers(roomId, playerIds);
    this.sendPush(roomId, tokens, title, body, data);
  }

  private notifyGm(
    roomId: string,
    title: string,
    body: string,
    data: Record<string, string | undefined>,
  ): void {
    const tokens = this.roomService.getGmPushTokens(roomId);
    this.sendPush(roomId, tokens, title, body, data);
  }

  private buildVotingProgress(state: GameState): VotingProgressPayload {
    const respondedCount =
      state.votingResponses?.size ?? state.actionsReceived?.size ?? 0;

    return {
      votedCount: respondedCount,
      respondedCount,
      totalVoters: state.players.filter((p) => p.alive).length,
    };
  }

  private emitVotingProgress(roomId: string, state: GameState): void {
    this.emitToAllPlayers(
      roomId,
      'voting:progress',
      this.buildVotingProgress(state),
    );
  }

  private buildVotingResultPayload(
    state: GameState,
    result: VotingResult,
    voterIds: string[],
  ): VotingResultPayload {
    const alivePlayers = voterIds
      .map((id) => state.players.find((player) => player.id === id))
      .filter((player): player is Player => Boolean(player));
    const voteEntries = alivePlayers.map((voter) => {
      const response = state.votingResponses?.get(voter.id);
      const targetId = response?.choice === 'target' ? response.targetId : null;
      const kind: VotingResponseKind = response?.choice ?? 'timeout';
      return {
        voterId: voter.id,
        voterName: voter.username,
        targetId,
        targetName: targetId ? this.resolveUsername(state, targetId) : null,
        kind,
      };
    });

    const totalsMap = new Map<string, number>();
    Object.values(state.votes).forEach((targetId) => {
      totalsMap.set(targetId, (totalsMap.get(targetId) ?? 0) + 1);
    });

    const totals = Array.from(totalsMap.entries())
      .map(([targetId, count]) => ({
        targetId,
        targetName: this.resolveUsername(state, targetId) ?? targetId,
        count,
      }))
      .sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));

    const respondedCount = voteEntries.filter(
      (vote) => vote.kind !== 'timeout',
    ).length;
    const targetVoteCount = voteEntries.filter(
      (vote) => vote.kind === 'target',
    ).length;
    const abstainCount = voteEntries.filter(
      (vote) => vote.kind === 'abstain',
    ).length;
    const timeoutCount = voteEntries.filter(
      (vote) => vote.kind === 'timeout',
    ).length;
    const totalVoters = alivePlayers.length;

    return {
      round: state.round,
      eliminatedPlayerId: result.eliminatedPlayerId,
      eliminatedPlayerName: this.resolveUsername(
        state,
        result.eliminatedPlayerId ?? undefined,
      ),
      cause: result.cause,
      tiedPlayerIds: result.tiedPlayerIds,
      tiedPlayers: result.tiedPlayerIds?.map((id) => ({
        id,
        username: this.resolveUsername(state, id) ?? id,
      })),
      additionalDeaths: result.additionalDeaths?.map((death) => ({
        playerId: death.playerId,
        playerName: this.resolveUsername(state, death.playerId) ?? death.playerId,
        cause: death.cause,
      })),
      votes: voteEntries,
      totals,
      abstainCount,
      timeoutCount,
      targetVoteCount,
      votedCount: respondedCount,
      respondedCount,
      totalVoters,
    };
  }

  private emitVotingResult(
    roomId: string,
    payload: VotingResultPayload,
    state: GameState,
  ): void {
    const payloadWithGameLog = {
      ...payload,
      gameLog: this.serializeGameLogForPlayer(state),
    };
    this.emitToAllPlayers(roomId, 'voting:result', payloadWithGameLog);
    this.emitToAllPlayers(roomId, 'votingResult', payloadWithGameLog);
  }

  // --- State sync ---

  private syncPlayerStatus(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const room = this.roomService.getRoom(roomId);
    if (!room) return;
    for (const gamePlayer of state.players) {
      const roomPlayer = room.players.find((p) => p.id === gamePlayer.id);
      if (roomPlayer) {
        roomPlayer.alive = gamePlayer.alive;
      }
    }
  }

  private resolveUsername(
    state: GameState,
    playerId: string | undefined,
  ): string | null {
    if (!playerId) return null;
    return state.players.find((p) => p.id === playerId)?.username ?? null;
  }

  private serializeGameLogForPlayer(state?: GameState): GameState['gameLog'] {
    if (!state) return [];
    if (state.winner) return state.gameLog;

    return state.gameLog.map((entry) => {
      if (entry.type !== 'night_result') return entry;

      return {
        ...entry,
        werewolfTarget: null,
        bodyguardTarget: null,
        seerTarget: null,
        seerResult: null,
        witchHeal: false,
        witchPoisonTarget: null,
        saved: [],
      };
    });
  }

  private buildNightLogEntry(
    state: GameState,
    result: NightDeathResult,
  ): GameState['gameLog'][number] {
    const saved: string[] = [];
    if (state.bodyguardTarget && state.bodyguardTarget === state.werewolfTarget) {
      const name = this.resolveUsername(state, state.bodyguardTarget);
      if (name) saved.push(name);
    }
    if (
      state.witch.healTarget &&
      state.witch.healTarget === state.werewolfTarget &&
      state.bodyguardTarget !== state.werewolfTarget
    ) {
      const name = this.resolveUsername(state, state.witch.healTarget);
      if (name) saved.push(name);
    }

    const seerResult = state.seerTarget
      ? GameEngine.getSeerResult(state, state.seerTarget)
      : null;

    return {
      type: 'night_result',
      round: state.round,
      werewolfTarget: this.resolveUsername(state, state.werewolfTarget),
      bodyguardTarget: this.resolveUsername(state, state.bodyguardTarget),
      seerTarget: this.resolveUsername(state, state.seerTarget),
      seerResult,
      witchHeal: !!state.witch.healTarget,
      witchPoisonTarget: this.resolveUsername(state, state.witch.poisonTarget),
      deaths: result.deaths.map((d) => ({
        username: state.players.find((p) => p.id === d.playerId)?.username ?? d.playerId,
        cause: d.cause,
      })),
      saved,
    };
  }

  private getLoverPartnerSnapshot(
    state: GameState,
    playerId: string,
  ): { id: string; username: string } | null {
    const partnerId = GameEngine.getLoverPartnerId(state, playerId);
    if (!partnerId) return null;
    const partner = state.players.find((p) => p.id === partnerId);
    return partner ? { id: partner.id, username: partner.username } : null;
  }

  private buildPlayerVotingState(
    state: GameState,
    playerId: string,
  ): PlayerVotingState {
    const response = state.votingResponses?.get(playerId);
    if (!response) {
      return {
        hasResponded: false,
        choice: null,
        targetId: null,
        targetName: null,
      };
    }

    return {
      hasResponded: true,
      choice: response.choice,
      targetId: response.targetId,
      targetName: response.targetId
        ? this.resolveUsername(state, response.targetId)
        : null,
    };
  }

  getPlayerVotingState(
    roomId: string,
    playerId: string,
  ): PlayerVotingState | undefined {
    const state = this.gameStates.get(roomId);
    if (!state || state.phase !== 'voting') return undefined;
    return this.buildPlayerVotingState(state, playerId);
  }

  getPlayerStateSnapshot(
    roomId: string,
    playerId: string,
  ): PlayerStateSnapshot | undefined {
    const state = this.gameStates.get(roomId);
    const room = this.roomService.getRoom(roomId);
    if (!room) return undefined;

    const roomPlayers = state?.players ?? room.players;
    const player = roomPlayers.find((p) => p.id === playerId);
    if (!player || player.status === 'rejected') return undefined;

    const pending = this.pendingResponses.get(roomId);
    const pendingForPlayer = pending?.rolePlayers.some((p) => p.id === playerId);
    const hasResponded = pending?.responded.has(playerId) ?? false;
    const nightPrompt =
      pending && pendingForPlayer && !hasResponded
        ? (pending.promptData as NightPromptSnapshot)
        : null;

    const snapshot: PlayerStateSnapshot = {
      roomCode: roomId,
      serverTime: Date.now(),
      phase: state?.phase ?? room.phase,
      round: state?.round ?? room.round,
      gameStarted: room.gameStarted === true,
      playerId,
      role: player.role,
      alive: player.alive ?? null,
      players: this.serializePlayersForSocket(roomPlayers, playerId),
      timer: state?.timerInfo,
      nightPrompt,
      hunterDeathShooting:
        state?.hunterShooting === true &&
        player.role === 'hunter' &&
        player.alive === false,
      winner: state?.winner,
      gameLog: this.serializeGameLogForPlayer(state),
      loverPartner: state
        ? this.getLoverPartnerSnapshot(state, playerId)
        : null,
    };

    if (state?.phase === 'voting') {
      snapshot.voting = {
        progress: this.buildVotingProgress(state),
        state: this.buildPlayerVotingState(state, playerId),
      };
    } else if (state?.lastVotingResult) {
      snapshot.voting = {
        result: state.lastVotingResult as VotingResultPayload,
      };
    }

    return snapshot;
  }

  getGmStateSnapshot(roomId: string): GmStateSnapshot | undefined {
    const room = this.roomService.getRoom(roomId);
    if (!room) return undefined;
    const state = this.gameStates.get(roomId);

    return {
      roomCode: roomId,
      serverTime: Date.now(),
      phase: state?.phase ?? room.phase,
      round: state?.round ?? room.round,
      gameStarted: room.gameStarted === true,
      players: state?.players ?? room.players,
      timer: state?.timerInfo,
      gmActionLog: state?.gmActionLog ?? [],
      winner: state?.winner,
      lovers: state?.lovers,
    };
  }

  // --- Role action orchestration ---

  private async emitToRoleAndWaitResponse(
    roomId: string,
    role: string,
    event: string,
    data: unknown,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    return new Promise((resolve) => {
      const state = this.gameStates.get(roomId);
      if (!state) return resolve(null);

      const rolePlayers = GameEngine.getPlayersByRole(state, role);
      if (rolePlayers.length === 0) return resolve(null);

      const responses: Array<{ playerId: string; payload: RoleResponse }> = [];
      const responded = new Set<string>();
      const timeoutMs = this.ROLE_TIMEOUTS[role] || 15000;
      const deadline = Date.now() + timeoutMs;

      // Store timer info in game state for reconnect recovery
      state.timerInfo = {
        context: role as TimerInfo['context'],
        durationMs: timeoutMs,
        deadline,
      } as TimerInfo;

      // Cleanup function to prevent memory leaks
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.pendingResponses.delete(roomId);
        if (state) state.timerInfo = undefined;
        // Emit timer stop to role players
        rolePlayers.forEach((player) => {
          this.server.to(player.id).emit('game:timerStop', {});
        });
      };

      // Timeout: auto-resolve with defaults if players don't respond
      const timeoutHandle = setTimeout(() => {
        for (const player of rolePlayers) {
          if (!responded.has(player.id)) {
            responded.add(player.id);
            const defaultPayload = GameEngine.getDefaultRoleResponse(
              role,
              state,
            );
            responses.push({ playerId: player.id, payload: defaultPayload });

            // Notify timed-out player
            this.server.to(player.id).emit('night:action-timeout', {
              message: 'Bạn đã hết thời gian. Lượt của bạn đã bị bỏ qua.',
            });
          }
        }

        if (state.gmRoomId) {
          this.emitToGM(roomId, state.gmRoomId, 'gm:nightAction', {
            step: role,
            action: 'timeout',
            message: `${GameEngine.getRoleDisplayName(role)} hết thời gian. Tự động bỏ qua.`,
            timestamp: Date.now(),
          });
        }

        cleanup();
        resolve(responses);
      }, timeoutMs);

      this.pendingResponses.set(roomId, {
        resolve: (value) => {
          cleanup();
          resolve(value as typeof responses);
        },
        responses,
        responded,
        rolePlayers,
        role,
        event,
        promptData: data,
        deadline,
        durationMs: timeoutMs,
      });

      this.notifyPlayers(
        roomId,
        rolePlayers.map((player) => player.id),
        `Đến lượt ${GameEngine.getRoleDisplayName(role)}`,
        'Hãy mở game để thực hiện lượt trước khi hết giờ.',
        {
          type: 'night-role-prompt',
          roomCode: roomId,
          participantKind: 'player',
          phase: 'night',
          role,
          deadline: String(deadline),
          url: `/room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );

      // Emit both the action event and timer start to role players
      rolePlayers.forEach((player) => {
        this.server.to(player.id).emit(event, data);
        this.server.to(player.id).emit('game:timerStart', {
          context: role,
          durationMs: timeoutMs,
          deadline,
        });
      });
    });
  }

  private async processRoleAction(
    roomId: string,
    role: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    switch (role) {
      case 'cupid':
        return await this.processCupidAction(roomId);
      case 'bodyguard':
        return await this.processBodyguardAction(roomId);
      case 'werewolf':
        return await this.processWerewolfAction(roomId);
      case 'seer':
        return await this.processSeerAction(roomId);
      case 'witch':
        return await this.processWitchAction(roomId);
      default:
        return null;
    }
  }

  private async processCupidAction(
    roomId: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const candidates = GameEngine.getCupidCandidates(state);
    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'cupid',
      'night:cupid-action',
      {
        message: 'Thần tình yêu thức dậy, hãy chọn hai người để ghép đôi.',
        candidates,
        type: 'cupid',
        minSelections: 2,
        maxSelections: 2,
      },
    );

    if (response && response.length > 0) {
      const cupidResponse = response[0];
      GameEngine.applyCupidAction(state, cupidResponse.payload.targetIds);
      if (state.lovers) {
        const [firstId, secondId] = state.lovers;
        const first = state.players.find((p) => p.id === firstId);
        const second = state.players.find((p) => p.id === secondId);
        if (first && second) {
          this.server.to(first.id).emit('night:cupid-linked', {
            partnerId: second.id,
            partnerName: second.username,
          });
          this.server.to(second.id).emit('night:cupid-linked', {
            partnerId: first.id,
            partnerName: first.username,
          });
        }
      }
    }

    return response;
  }

  private async processWerewolfAction(
    roomId: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const candidates = GameEngine.getWerewolfCandidates(state);
    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'werewolf',
      'night:werewolf-action',
      {
        message: 'Sói thức dậy, hãy chọn người để cắn.',
        candidates,
        type: 'werewolf',
      },
    );

    if (response && response.length > 0) {
      GameEngine.applyWerewolfVotes(state, response);
    }

    return response;
  }

  private async processSeerAction(
    roomId: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const candidates = GameEngine.getSeerCandidates(state);
    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'seer',
      'night:seer-action',
      {
        message: 'Tiên tri thức dậy, hãy chọn người để xem.',
        candidates,
        type: 'seer',
      },
    );

    if (response && response.length > 0) {
      const seerResponse = response[0];
      GameEngine.applySeerAction(state, seerResponse.payload.targetId);

      // Send the result only to the seer — never include it in the candidates payload
      if (seerResponse.payload.targetId) {
        const isWerewolf = GameEngine.getSeerResult(
          state,
          seerResponse.payload.targetId,
        );
        this.server.to(seerResponse.playerId).emit('night:seer-result', {
          targetId: seerResponse.payload.targetId,
          isWerewolf,
        });
      }
    }

    return response;
  }

  private async processWitchAction(
    roomId: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const witchData = GameEngine.getWitchActionData(state);
    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'witch',
      'night:witch-action',
      {
        message: 'Phù thủy thức dậy và chọn người để hồi sinh hoặc đầu độc.',
        ...witchData,
        type: 'witch',
      },
    );

    if (response && response.length > 0) {
      const witchResponse = response[0];

      // Guard: witch may not poison herself. Healing and poisoning in the same night is allowed.
      const witchPlayer = state.players.find(
        (p) => p.id === witchResponse.playerId,
      );
      const poisonTargetId = witchResponse.payload.poisonTargetId;
      const heal = witchResponse.payload.heal;

      const selfPoison = poisonTargetId && witchPlayer?.id === poisonTargetId;

      if (selfPoison) {
        this.logger.warn(
          `Witch action rejected for ${witchResponse.playerId}: selfPoison=${String(selfPoison)}`,
        );
      } else {
        GameEngine.applyWitchAction(state, heal, poisonTargetId);
      }
    }

    return response;
  }

  private async processBodyguardAction(
    roomId: string,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const candidates = GameEngine.getBodyguardCandidates(state);
    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'bodyguard',
      'night:bodyguard-action',
      {
        message: 'Bảo vệ thức dậy, hãy chọn người để bảo vệ.',
        candidates,
        lastProtected: state.lastProtected,
        type: 'bodyguard',
      },
    );

    if (response && response.length > 0) {
      const bodyguardResponse = response[0];
      GameEngine.applyBodyguardAction(
        state,
        bodyguardResponse.payload.targetId,
      );
    }

    return response;
  }

  // --- Night resolution ---

  private resolveNightActions(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    const result: NightDeathResult = GameEngine.resolveNightActions(state);
    this.syncPlayerStatus(roomId);
    state.gameLog.push(this.buildNightLogEntry(state, result));

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      const diedPlayerIds = result.deaths.map((d) => d.playerId);

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:nightAction', {
          step: 'nightEnd',
          action: 'end',
          message: `Trời sáng rồi, mời mọi người thức dậy. ${
            result.deaths.length > 0
              ? `Hôm qua có ${result.deaths.length} người chết, đó là: ${result.deaths
                  .map(
                    (d) =>
                      state.players.find((p) => p.id === d.playerId)?.username,
                  )
                  .join(', ')}.`
              : `Hôm qua không có người chết.`
          }`,
          timestamp: Date.now(),
        });
      }

      this.emitToAllPlayers(roomId, 'game:nightResult', {
        diedPlayerIds,
        deaths: result.deaths,
        cause: result.deaths.length > 0 ? result.deaths[0].cause : 'protected',
        gameLog: this.serializeGameLogForPlayer(state),
      });

      // --- Check if hunter was killed at night → block phase transition ---
      const deadHunter = result.deaths.find(
        (d) =>
          state.players.find((p) => p.id === d.playerId)?.role === 'hunter',
      );

      if (deadHunter) {
        state.hunterShooting = true;
        state.hunterDeathContext = 'night';

        if (state.gmRoomId) {
          this.emitToGM(roomId, state.gmRoomId, 'gm:hunterAction', {
            type: 'hunterDied',
            message: `Thợ săn đã chết trong đêm. Chờ thợ săn bắn hoặc bỏ qua.`,
          });
        }

        GameEngine.resetNightState(state);

        // Emit hunter shoot event so hunter sees the shoot UI
        this.emitToAllPlayers(roomId, 'game:hunterShoot', {
          hunterId: deadHunter.playerId,
        });
        this.notifyPlayers(
          roomId,
          [deadHunter.playerId],
          'Thợ săn, đến lượt bạn',
          'Bạn đã chết. Hãy chọn người để bắn hoặc bỏ qua.',
          {
            type: 'hunter-shoot',
            roomCode: roomId,
            participantKind: 'player',
            phase: state.phase ?? undefined,
            role: 'hunter',
            url: `/room/${roomId}`,
            snapshotHint: 'request-on-open',
          },
        );

        return; // Phase blocked — wait for hunter's response
      }

      GameEngine.resetNightState(state);

      // Use injectable delayFn for testability
      const generation = this.getRoomGeneration(roomId);
      void this.delayFn(3000).then(() => {
        if (this.isCurrentGeneration(roomId, generation)) {
          this.startDayPhase(roomId);
        }
      });
    }
  }

  // --- Voting resolution ---

  private handleVoting(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    // Mark voting as resolved to prevent double-trigger
    state.votingResolved = true;

    // Stop the timer
    state.timerInfo = undefined;
    this.emitToAllPlayers(roomId, 'game:timerStop', {});

    const voterIds = state.players
      .filter((player) => player.alive)
      .map((player) => player.id);
    const result: VotingResult = GameEngine.resolveVoting(state);
    const votingResultPayload = this.buildVotingResultPayload(
      state,
      result,
      voterIds,
    );
    state.lastVotingResult = votingResultPayload;
    this.syncPlayerStatus(roomId);

    // --- CAPTURE VOTING LOG (before reset) ---
    state.gameLog.push({
      type: 'voting_result',
      round: state.round,
      votes: Object.entries(state.votes).map(([voterId, targetId]) => ({
        voter: state.players.find((p) => p.id === voterId)?.username ?? voterId,
        target:
          state.players.find((p) => p.id === targetId)?.username ?? targetId,
      })),
      eliminatedPlayer: result.eliminatedPlayerId
        ? (state.players.find((p) => p.id === result.eliminatedPlayerId)
            ?.username ?? null)
        : null,
      cause: result.cause,
      tiedPlayers: result.tiedPlayerIds?.map(
        (id) => state.players.find((p) => p.id === id)?.username ?? id,
      ),
    });

    // Tanner wins immediately
    if (result.isTanner) {
      state.winner = 'tanner';
      state.gameLog.push({
        type: 'game_end',
        round: state.round,
        winner: 'tanner',
        totalRounds: state.round,
        players: state.players.map((p) => ({
          username: p.username,
          role: p.role ?? 'unknown',
          alive: p.alive ?? false,
        })),
      });
      this.emitToAllPlayers(roomId, 'game:gameEnded', {
        winner: 'tanner',
        players: state.players,
        gameLog: state.gameLog,
      });
      this.notifyPlayers(
        roomId,
        state.players.map((player) => player.id),
        'Ván Ma Sói đã kết thúc',
        'Chán đời thắng!',
        {
          type: 'game-ended',
          roomCode: roomId,
          participantKind: 'player',
          phase: 'ended',
          url: `/room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );
      this.notifyGm(roomId, 'Ván Ma Sói đã kết thúc', 'Chán đời thắng!', {
        type: 'game-ended',
        roomCode: roomId,
        participantKind: 'gm',
        phase: 'ended',
        url: `/gm-room/${roomId}`,
        snapshotHint: 'request-on-open',
      });
      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:gameEnded', {
          type: 'gameEnded',
          message: `Trò chơi kết thúc. Chán đời thắng khi bị vote chết!`,
          winner: 'tanner',
        });
      }
      return;
    }

    // No votes or tie
    if (!result.eliminatedPlayerId) {
      state.phase = 'conclude';

      let message: string;
      if (result.cause === 'tie') {
        const tiedNames = (result.tiedPlayerIds || [])
          .map((id) => state.players.find((p) => p.id === id)?.username)
          .join(', ');
        message = `Hòa phiếu giữa ${tiedNames}. Không ai bị loại.`;
      } else {
        message = 'Không ai bỏ phiếu. Không ai bị loại.';
      }

      this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'conclude' });
      this.emitVotingResult(roomId, votingResultPayload, state);

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:votingAction', {
          type: 'votingAction',
          message,
        });
      }

      GameEngine.resetVotingState(state);

      const winner = this.checkWinCondition(roomId);
      if (!winner) {
        const generation = this.getRoomGeneration(roomId);
        void this.delayFn(3000).then(() => {
          if (this.isCurrentGeneration(roomId, generation)) {
            void this.startNightPhase(roomId);
          }
        });
      }
      return;
    }

    // Hunter voted out — show voting result publicly, then wait for their shoot action
    if (result.cause === 'hunter') {
      state.phase = 'conclude';
      state.hunterShooting = true;
      state.hunterDeathContext = 'vote';
      this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'conclude' });
      this.emitVotingResult(roomId, votingResultPayload, state);
      const hunterId = result.hunterDeathPlayerId ?? result.eliminatedPlayerId;
      this.emitToAllPlayers(roomId, 'game:hunterShoot', {
        hunterId,
      });
      this.notifyPlayers(
        roomId,
        [hunterId],
        'Thợ săn, đến lượt bạn',
        'Bạn đã bị loại. Hãy chọn người để bắn hoặc bỏ qua.',
        {
          type: 'hunter-shoot',
          roomCode: roomId,
          participantKind: 'player',
          phase: state.phase ?? undefined,
          role: 'hunter',
          url: `/room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );
      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:hunterAction', {
          type: 'hunterDied',
          message: 'Thợ săn bị loại do bỏ phiếu. Chờ thợ săn bắn hoặc bỏ qua.',
        });
      }
      GameEngine.resetVotingState(state);
      return;
    }

    // Normal elimination
    state.phase = 'conclude';
    const eliminated = state.players.find(
      (p) => p.id === result.eliminatedPlayerId,
    );

    if (state.gmRoomId) {
      this.emitToGM(roomId, state.gmRoomId, 'gm:votingAction', {
        type: 'votingAction',
        message: `Người chơi ${eliminated?.username} bị loại.`,
      });
    }

    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'conclude' });
    this.emitVotingResult(roomId, votingResultPayload, state);

    GameEngine.resetVotingState(state);

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      const generation = this.getRoomGeneration(roomId);
      void this.delayFn(3000).then(() => {
        if (this.isCurrentGeneration(roomId, generation)) {
          void this.startNightPhase(roomId);
        }
      });
    }
  }

  // --- Phase transitions ---

  async startNightPhase(roomId: string) {
    if (!this.acquireTransitionLock(roomId)) return;
    const generation = this.getRoomGeneration(roomId);

    try {
      const state = this.gameStates.get(roomId);
      if (!state) return;

      GameEngine.prepareNightPhase(state);
      this.emitToAllPlayers(roomId, 'game:phaseChanged', {
        phase: 'night',
      });

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:nightAction', {
          step: 'nightStart',
          action: 'start',
          message: 'Đêm đến, tất cả mọi người nhắm mắt lại.',
          timestamp: Date.now(),
        });
      }

      await this.delay(2000);
      if (!this.isCurrentGeneration(roomId, generation)) return;

      const roles =
        state.round === 1 && !state.cupidUsed
          ? ['cupid', 'bodyguard', 'werewolf', 'witch', 'seer']
          : ['bodyguard', 'werewolf', 'witch', 'seer'];

      for (const role of roles) {
        const aliveRolePlayers = GameEngine.getPlayersByRole(state, role);
        const isRoleActive = aliveRolePlayers.length > 0;

        state.currentNightStep = role as GameState['currentNightStep'];

        // GM always sees role start (reads the script aloud)
        if (state.gmRoomId) {
          this.emitToGM(roomId, state.gmRoomId, 'gm:nightAction', {
            step: role,
            action: 'start',
            message: `Mời ${GameEngine.getRoleDisplayName(role)} thức dậy.`,
            players: isRoleActive
              ? aliveRolePlayers.map((p) => ({
                  id: p.id,
                  username: p.username,
                }))
              : [],
            timestamp: Date.now(),
          });
        }

        let response: Array<{
          playerId: string;
          payload: RoleResponse;
        }> | null = null;

        if (isRoleActive) {
          // Real role action: emit to alive players and wait for response
          response = await this.processRoleAction(roomId, role);
        } else {
          // Dead or absent role: simulate a fake delay (no events to players)
          await this.simulateDeadRoleAction();
        }
        if (!this.isCurrentGeneration(roomId, generation)) return;

        // GM always sees role complete (reads "go back to sleep")
        if (state.gmRoomId) {
          this.emitToGM(roomId, state.gmRoomId, 'gm:nightAction', {
            step: role,
            action: 'complete',
            message: `${GameEngine.getRoleDisplayName(role)} đã hoàn thành. Vui lòng nhắm mắt lại.`,
            response: isRoleActive ? response : null,
            timestamp: Date.now(),
          });
        }
      }

      this.resolveNightActions(roomId);
    } finally {
      this.releaseTransitionLock(roomId);
    }
  }

  startDayPhase(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    state.phase = 'day';
    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'day' });

    this.notifyPlayers(
      roomId,
      state.players
        .filter((player) => player.alive)
        .map((player) => player.id),
      'Trời sáng rồi',
      'Mở game để xem kết quả đêm và thảo luận.',
      {
        type: 'day-start',
        roomCode: roomId,
        participantKind: 'player',
        phase: 'day',
        url: `/room/${roomId}`,
        snapshotHint: 'request-on-open',
      },
    );

    this.notifyGm(roomId, 'GM: bắt đầu ban ngày', 'Mời cả làng thảo luận.', {
      type: 'gm-action',
      roomCode: roomId,
      participantKind: 'gm',
      phase: 'day',
      url: `/gm-room/${roomId}`,
      snapshotHint: 'request-on-open',
    });

    if (state.gmRoomId) {
      this.emitToGM(roomId, state.gmRoomId, 'gm:votingAction', {
        type: 'phaseChanged',
        message: 'Mời cả làng bàn luận',
      });
    }
  }

  startVotingPhase(roomId: string): void {
    if (!this.acquireTransitionLock(roomId)) return;

    try {
      const state = this.gameStates.get(roomId);
      if (!state) return;

      state.phase = 'voting';
      state.lastVotingResult = undefined;
      state.actionsReceived = new Set();
      state.votingResponses = new Map();
      state.votes = {};
      state.votingResolved = false;
      state.hunterShooting = false;

      const votingDuration = process.env.NODE_ENV === 'test' ? 1000 : 45000;
      const deadline = Date.now() + votingDuration;

      // Store timer info for reconnect recovery
      state.timerInfo = {
        context: 'voting',
        durationMs: votingDuration,
        deadline,
      } as TimerInfo;

      if (state.phaseTimeout) clearTimeout(state.phaseTimeout);
      state.phaseTimeout = setTimeout(() => {
        try {
          this.handleVoting(roomId);
          if (state.gmRoomId && state.phase !== 'ended') {
            this.emitToGM(roomId, state.gmRoomId, 'gm:votingAction', {
              type: 'votingEnded',
              message: 'Bỏ phiếu kết thúc.',
            });
          }
        } catch (error) {
          this.logger.error(
            `Error in voting timeout for room ${roomId}`,
            error,
          );
        }
      }, votingDuration);

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:votingAction', {
          type: 'phaseChanged',
          message:
            'Chuyển sang giai đoạn bỏ phiếu, các bạn có 45 giây để bỏ phiếu.',
        });
      }

      this.emitToAllPlayers(roomId, 'game:phaseChanged', {
        phase: 'voting',
      });

      // Emit timer start to all players
      this.emitToAllPlayers(roomId, 'game:timerStart', {
        context: 'voting',
        durationMs: votingDuration,
        deadline,
      });

      this.notifyPlayers(
        roomId,
        state.players.filter((player) => player.alive).map((player) => player.id),
        'Đã đến lúc bỏ phiếu',
        'Bạn có 45 giây để bỏ phiếu hoặc bỏ qua.',
        {
          type: 'voting-start',
          roomCode: roomId,
          participantKind: 'player',
          phase: 'voting',
          deadline: String(deadline),
          url: `/room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );

      this.notifyGm(
        roomId,
        'GM: bắt đầu bỏ phiếu',
        'Người chơi có 45 giây để bỏ phiếu.',
        {
          type: 'gm-action',
          roomCode: roomId,
          participantKind: 'gm',
          phase: 'voting',
          deadline: String(deadline),
          url: `/gm-room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );

      this.emitVotingProgress(roomId, state);
    } catch (error) {
      this.logger.error(
        `Error starting voting phase for room ${roomId}`,
        error,
      );
      // Rollback phase and cleanup on error
      const state = this.gameStates.get(roomId);
      if (state) {
        if (state.phaseTimeout) {
          clearTimeout(state.phaseTimeout);
          state.phaseTimeout = undefined;
        }
        // Rollback to day phase so game can continue
        state.phase = 'day';
      }
    } finally {
      this.releaseTransitionLock(roomId);
    }
  }

  // --- Win condition ---

  checkWinCondition(
    roomId: string,
  ): 'villagers' | 'werewolves' | 'tanner' | null {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const winner = GameEngine.checkWinCondition(state);

    if (winner) {
      state.phase = 'ended';
      state.winner = winner;
      this.syncPlayerStatus(roomId);

      // --- CAPTURE GAME END LOG ---
      state.gameLog.push({
        type: 'game_end',
        round: state.round,
        winner,
        totalRounds: state.round,
        players: state.players.map((p) => ({
          username: p.username,
          role: p.role ?? 'unknown',
          alive: p.alive ?? false,
        })),
      });

      this.emitToAllPlayers(roomId, 'game:gameEnded', {
        winner,
        players: state.players,
        gameLog: state.gameLog,
      });

      const winnerDisplayName =
        winner === 'villagers'
          ? 'Dân làng'
          : winner === 'werewolves'
            ? 'Sói'
            : 'Chán đời';
      this.notifyPlayers(
        roomId,
        state.players.map((player) => player.id),
        'Ván Ma Sói đã kết thúc',
        `${winnerDisplayName} thắng!`,
        {
          type: 'game-ended',
          roomCode: roomId,
          participantKind: 'player',
          phase: 'ended',
          url: `/room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );
      this.notifyGm(
        roomId,
        'Ván Ma Sói đã kết thúc',
        `${winnerDisplayName} thắng!`,
        {
          type: 'game-ended',
          roomCode: roomId,
          participantKind: 'gm',
          phase: 'ended',
          url: `/gm-room/${roomId}`,
          snapshotHint: 'request-on-open',
        },
      );

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:gameEnded', {
          type: 'gameEnded',
          message: `Trò chơi kết thúc. ${winnerDisplayName} thắng!`,
          winner,
        });
      }
    }

    return winner;
  }

  // --- Response handlers ---

  handleRoleResponse(roomId: string, playerId: string, payload: RoleResponse) {
    const pending = this.pendingResponses.get(roomId);
    if (!pending) return;

    const { resolve, responses, responded, rolePlayers } = pending;
    const expectedPlayer = rolePlayers.find((player) => player.id === playerId);
    if (!expectedPlayer) return;

    if (!responded.has(playerId)) {
      responded.add(playerId);
      responses.push({ playerId, payload });

      if (responded.size === rolePlayers.length) {
        resolve(responses);
        this.pendingResponses.delete(roomId);
      }
    }
  }

  handleVotingResponse(
    roomId: string,
    playerId: string,
    payload: { targetId?: string | null; choice?: VotingChoice },
  ): VotingSubmissionAck {
    const state = this.gameStates.get(roomId);
    if (!state || state.phase !== 'voting') {
      return {
        success: false,
        status: 'rejected',
        reason: 'not_voting',
        message: 'Hiện không trong giai đoạn bỏ phiếu.',
      };
    }
    if (state.votingResolved) {
      return {
        success: false,
        status: 'rejected',
        reason: 'resolved',
        message: 'Bỏ phiếu đã kết thúc.',
      };
    }

    const result = GameEngine.recordVote(
      state,
      playerId,
      payload.targetId,
      payload.choice,
    );
    const votingState = this.buildPlayerVotingState(state, playerId);
    const progress = this.buildVotingProgress(state);

    if (result.status === 'rejected') {
      return {
        success: false,
        status: 'rejected',
        reason: result.reason,
        message:
          result.reason === 'invalid_target'
            ? 'Mục tiêu bỏ phiếu không hợp lệ.'
            : 'Không thể ghi nhận phiếu bầu.',
        votingState,
        progress,
      };
    }

    this.server.to(playerId).emit('voting:state', votingState);

    if (result.status === 'accepted') {
      this.emitVotingProgress(roomId, state);
    }

    const alivePlayers = state.players.filter((p) => p.alive);
    if (progress.respondedCount >= alivePlayers.length) {
      if (state.phaseTimeout) {
        clearTimeout(state.phaseTimeout);
        state.phaseTimeout = undefined;
      }
      this.handleVoting(roomId);
    }

    return {
      success: true,
      status: result.status,
      reason: result.reason,
      message:
        result.status === 'duplicate'
          ? 'Phiếu của bạn đã được ghi nhận trước đó.'
          : 'Đã ghi nhận phiếu bầu.',
      votingState,
      progress,
    };
  }

  // --- Hunter ---

  handleHunterShoot(roomId: string, targetId: string) {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    const success = GameEngine.applyHunterShoot(state, targetId);
    if (!success) return;

    const deaths = GameEngine.applyLoverDeaths(state, [
      { playerId: targetId, cause: 'hunter' },
    ]);
    const additionalDeaths = deaths
      .filter((death) => death.playerId !== targetId && death.cause === 'lover')
      .map((death) => ({
        playerId: death.playerId,
        playerName: this.resolveUsername(state, death.playerId) ?? death.playerId,
        cause: 'lover' as const,
      }));

    this.syncPlayerStatus(roomId);

    const target = state.players.find((p) => p.id === targetId);

    // --- CAPTURE HUNTER SHOT LOG ---
    state.gameLog.push({
      type: 'hunter_shot',
      round: state.round,
      hunter:
        state.players.find((p) => p.role === 'hunter' && !p.alive)?.username ??
        'Thợ săn',
      target: target?.username ?? null,
    });

    this.emitToAllPlayers(roomId, 'game:hunterShot', {
      hunterId: state.players.find((p) => p.role === 'hunter' && !p.alive)?.id,
      targetId,
      additionalDeaths,
      gameLog: this.serializeGameLogForPlayer(state),
    });

    if (state.gmRoomId) {
      this.emitToGM(roomId, state.gmRoomId, 'gm:hunterAction', {
        type: 'hunterShot',
        message: `Thợ săn đã bắn ${target?.username}.`,
        targetId,
      });
    }

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      const context = state.hunterDeathContext;
      const generation = this.getRoomGeneration(roomId);
      state.hunterShooting = false;
      state.hunterDeathContext = undefined;
      void this.delayFn(3000).then(() => {
        if (!this.isCurrentGeneration(roomId, generation)) return;
        if (context === 'night') {
          this.startDayPhase(roomId);
        } else {
          void this.startNightPhase(roomId);
        }
      });
    }
  }

  handleHunterDeathShoot(
    roomId: string,
    hunterId: string,
    targetId?: string,
  ): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    // Guard: only process while hunter shoot phase is active
    if (!state.hunterShooting) {
      this.logger.warn(
        `Hunter shoot attempt rejected: hunterShooting is false (possible double-trigger)`,
      );
      return;
    }

    // Validate that hunterId matches the actual dead hunter
    const deadHunter = state.players.find(
      (p) => p.role === 'hunter' && !p.alive && p.id === hunterId,
    );
    if (!deadHunter) {
      this.logger.warn(
        `Invalid hunter death shoot attempt: hunterId=${hunterId} does not match dead hunter`,
      );
      return;
    }

    if (targetId) {
      this.handleHunterShoot(roomId, targetId);
    } else {
      // Hunter chose not to shoot
      // --- CAPTURE HUNTER SKIP LOG ---
      state.gameLog.push({
        type: 'hunter_shot',
        round: state.round,
        hunter: deadHunter.username,
        target: null,
      });

      this.emitToAllPlayers(roomId, 'game:hunterShot', {
        hunterId: deadHunter.id,
        targetId: null,
        additionalDeaths: [],
        gameLog: this.serializeGameLogForPlayer(state),
      });

      if (state.gmRoomId) {
        this.emitToGM(roomId, state.gmRoomId, 'gm:hunterAction', {
          type: 'hunterSkipped',
          message: `Thợ săn đã bỏ qua lượt bắn.`,
        });
      }

      const winner = this.checkWinCondition(roomId);
      if (!winner) {
        const context = state.hunterDeathContext;
        const generation = this.getRoomGeneration(roomId);
        state.hunterShooting = false;
        state.hunterDeathContext = undefined;
        void this.delayFn(3000).then(
          () => {
            if (!this.isCurrentGeneration(roomId, generation)) return;
            if (context === 'night') {
              this.startDayPhase(roomId);
            } else {
              void this.startNightPhase(roomId);
            }
          },
          () => {
            // Ignore errors from phase transition (will be logged elsewhere)
          },
        );
      }
    }
  }

  // --- GM room ---

  setGmRoom(roomId: string, gmRoomId: string): void {
    const state = this.gameStates.get(roomId);
    if (state) {
      state.gmRoomId = gmRoomId;
    }
  }

  /** Sync an explicit player leave into the active GameState. */
  handlePlayerLeave(roomId: string, playerId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    const player = state.players.find((p) => p.id === playerId);
    if (!player) return;

    player.alive = false;

    const pending = this.pendingResponses.get(roomId);
    if (pending) {
      const pendingPlayer = pending.rolePlayers.find((p) => p.id === playerId);
      if (pendingPlayer && !pending.responded.has(playerId)) {
        pending.responded.add(playerId);
        pending.responses.push({
          playerId,
          payload: GameEngine.getDefaultRoleResponse(
            state.currentNightStep ?? pendingPlayer.role ?? '',
            state,
          ),
        });
        if (pending.responded.size >= pending.rolePlayers.length) {
          pending.resolve(pending.responses);
          this.pendingResponses.delete(roomId);
        }
      }
    }

    if (state.hunterShooting && player.role === 'hunter') {
      state.gameLog.push({
        type: 'hunter_shot',
        round: state.round,
        hunter: player.username,
        target: null,
      });
      state.hunterShooting = false;
      state.hunterDeathContext = undefined;
    }

    this.syncPlayerStatus(roomId);
    const winner = this.checkWinCondition(roomId);
    if (winner) return;

    if (state.phase === 'voting' && !state.votingResolved) {
      this.emitVotingProgress(roomId, state);
      const alivePlayers = state.players.filter((p) => p.alive);
      const { respondedCount } = this.buildVotingProgress(state);
      if (respondedCount >= alivePlayers.length) {
        if (state.phaseTimeout) {
          clearTimeout(state.phaseTimeout);
          state.phaseTimeout = undefined;
        }
        this.handleVoting(roomId);
      }
    }
  }

  /** Mirror player profile changes into active GameState. */
  updatePlayerInfo(
    roomId: string,
    playerId: string,
    username: string,
    avatarKey: number,
  ): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return;
    player.username = username;
    player.avatarKey = avatarKey;
  }

  private clearGameState(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (state?.phaseTimeout) clearTimeout(state.phaseTimeout);
    if (state) {
      state.timerInfo = undefined;
      this.emitToAllPlayers(roomId, 'game:timerStop', {});
    }
    this.gameStates.delete(roomId);

    const pending = this.pendingResponses.get(roomId);
    if (pending) {
      // Resolve with empty array so any awaiting promise unblocks
      pending.resolve([]);
      this.pendingResponses.delete(roomId);
    }

    this.releaseTransitionLock(roomId);
  }

  /** Remove active game state while preserving the room for replay. */
  resetRoomState(roomId: string): void {
    this.bumpRoomGeneration(roomId);
    this.clearGameState(roomId);
  }

  /** Remove all in-memory state for a room (called when the room is cleaned up). */
  cleanupRoom(roomId: string): void {
    this.bumpRoomGeneration(roomId);
    this.clearGameState(roomId);
  }

  // --- Init ---

  initGameState(roomId: string, players: Player[], gmRoomId?: string): void {
    if (this.gameStates.has(roomId)) return;
    const state = GameEngine.createInitialState(players, gmRoomId);
    this.gameStates.set(roomId, state);
  }

  /** Sync a GM elimination into the active GameState. */
  eliminatePlayer(roomId: string, playerId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const player = state.players.find((p) => p.id === playerId);
    if (player) player.alive = false;
  }

  /** Sync a GM revival into the active GameState. */
  revivePlayer(roomId: string, playerId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const player = state.players.find((p) => p.id === playerId);
    if (player) player.alive = true;
  }

  /** Update a player's socket ID in the game state after reconnect. */
  updatePlayerSocketId(
    roomId: string,
    persistentId: string,
    newSocketId: string,
    previousSocketId?: string,
  ): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const player = state.players.find(
      (p) =>
        (p as Player & { persistentId?: string }).persistentId === persistentId,
    );
    if (!player) return;

    const oldSocketId = previousSocketId ?? player.id;
    player.id = newSocketId;

    if (oldSocketId === newSocketId) return;

    const pending = this.pendingResponses.get(roomId);
    if (pending) {
      pending.rolePlayers = pending.rolePlayers.map((rolePlayer) =>
        rolePlayer.id === oldSocketId
          ? { ...rolePlayer, id: newSocketId }
          : rolePlayer,
      );
      if (pending.responded.has(oldSocketId)) {
        pending.responded.delete(oldSocketId);
        pending.responded.add(newSocketId);
      }
      pending.responses = pending.responses.map((response) =>
        response.playerId === oldSocketId
          ? { ...response, playerId: newSocketId }
          : response,
      );
    }

    if (state.actionsReceived?.has(oldSocketId)) {
      state.actionsReceived.delete(oldSocketId);
      state.actionsReceived.add(newSocketId);
    }

    if (state.votes[oldSocketId]) {
      state.votes[newSocketId] = state.votes[oldSocketId];
      delete state.votes[oldSocketId];
    }

    Object.entries(state.votes).forEach(([voterId, targetId]) => {
      if (targetId === oldSocketId) {
        state.votes[voterId] = newSocketId;
      }
    });

    if (state.votingResponses?.has(oldSocketId)) {
      const response = state.votingResponses.get(oldSocketId);
      state.votingResponses.delete(oldSocketId);
      if (response) {
        state.votingResponses.set(newSocketId, {
          ...response,
          voterId: newSocketId,
          targetId:
            response.targetId === oldSocketId ? newSocketId : response.targetId,
        });
      }
    }

    state.votingResponses?.forEach((response, voterId) => {
      if (response.targetId === oldSocketId) {
        state.votingResponses?.set(voterId, {
          ...response,
          targetId: newSocketId,
        });
      }
    });

    if (state.lovers) {
      state.lovers = state.lovers.map((id) =>
        id === oldSocketId ? newSocketId : id,
      ) as [string, string];
    }

    if (state.cupidTargetIds) {
      state.cupidTargetIds = state.cupidTargetIds.map((id) =>
        id === oldSocketId ? newSocketId : id,
      ) as [string, string];
    }
  }
}
