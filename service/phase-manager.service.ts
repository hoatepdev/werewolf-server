import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { Phase, Player } from '../types';
import { RoomService } from './room.service';
import {
  GameEngine,
  GameState,
  RoleResponse,
  NightDeathResult,
  VotingResult,
  TimerInfo,
} from './game-engine';

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
    }
  >();
  private transitionLocks = new Set<string>();

  private readonly ROLE_TIMEOUTS: Record<string, number> =
    process.env.NODE_ENV === 'test'
      ? { bodyguard: 100, werewolf: 100, witch: 100, seer: 100 }
      : { bodyguard: 30000, werewolf: 60000, witch: 30000, seer: 30000 };

  protected delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(private readonly roomService: RoomService) {}

  setServer(server: Server) {
    this.server = server;
  }

  private delay(ms: number) {
    return this.delayFn(ms);
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

  // --- Emit helpers ---

  private emitToGM(gmRoomId: string, event: string, payload?: any): void {
    if (gmRoomId) {
      this.server.to(gmRoomId).emit(event, payload);
    }
  }

  private emitToAllPlayers(roomId: string, event: string, payload?: any): void {
    this.server.to(roomId).emit(event, payload);
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
          this.emitToGM(state.gmRoomId, 'gm:nightAction', {
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
      });

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

      // Guard: witch may not poison herself, and may not heal + poison in the same night
      const witchPlayer = state.players.find(
        (p) => p.id === witchResponse.playerId,
      );
      const poisonTargetId = witchResponse.payload.poisonTargetId;
      const heal = witchResponse.payload.heal;

      const selfPoison = poisonTargetId && witchPlayer?.id === poisonTargetId;
      const bothUsed = heal && poisonTargetId;

      if (selfPoison || bothUsed) {
        this.logger.warn(
          `Witch action rejected for ${witchResponse.playerId}: selfPoison=${String(selfPoison)}, bothUsed=${String(bothUsed)}`,
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

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      const diedPlayerIds = result.deaths.map((d) => d.playerId);

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
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
          this.emitToGM(state.gmRoomId, 'gm:hunterAction', {
            type: 'hunterDied',
            message: `Thợ săn đã chết trong đêm. Chờ thợ săn bắn hoặc bỏ qua.`,
          });
        }

        // Capture log data before reset
        const savedHunterBranch: string[] = [];
        if (
          state.bodyguardTarget &&
          state.bodyguardTarget === state.werewolfTarget
        ) {
          const name = this.resolveUsername(state, state.bodyguardTarget);
          if (name) savedHunterBranch.push(name);
        }
        if (
          state.witch.healTarget &&
          state.witch.healTarget === state.werewolfTarget &&
          state.bodyguardTarget !== state.werewolfTarget
        ) {
          const name = this.resolveUsername(state, state.witch.healTarget);
          if (name) savedHunterBranch.push(name);
        }
        let seerResultHunterBranch: boolean | null = null;
        if (state.seerTarget) {
          seerResultHunterBranch = GameEngine.getSeerResult(
            state,
            state.seerTarget,
          );
        }

        state.gameLog.push({
          type: 'night_result',
          round: state.round,
          werewolfTarget: this.resolveUsername(state, state.werewolfTarget),
          bodyguardTarget: this.resolveUsername(state, state.bodyguardTarget),
          seerTarget: this.resolveUsername(state, state.seerTarget),
          seerResult: seerResultHunterBranch,
          witchHeal: !!state.witch.healTarget,
          witchPoisonTarget: this.resolveUsername(
            state,
            state.witch.poisonTarget,
          ),
          deaths: result.deaths.map((d) => ({
            username:
              state.players.find((p) => p.id === d.playerId)?.username ??
              d.playerId,
            cause: d.cause,
          })),
          saved: savedHunterBranch,
        });

        GameEngine.resetNightState(state);

        // Emit hunter shoot event so hunter sees the shoot UI
        this.emitToAllPlayers(roomId, 'game:hunterShoot', {
          hunterId: deadHunter.playerId,
        });

        return; // Phase blocked — wait for hunter's response
      }

      // --- CAPTURE NIGHT LOG (before reset) ---
      const saved: string[] = [];
      // Detect bodyguard save
      if (
        state.bodyguardTarget &&
        state.bodyguardTarget === state.werewolfTarget
      ) {
        const name = this.resolveUsername(state, state.bodyguardTarget);
        if (name) saved.push(name);
      }
      // Detect witch heal save (only if bodyguard didn't already save)
      if (
        state.witch.healTarget &&
        state.witch.healTarget === state.werewolfTarget &&
        state.bodyguardTarget !== state.werewolfTarget
      ) {
        const name = this.resolveUsername(state, state.witch.healTarget);
        if (name) saved.push(name);
      }
      // Seer result: look up whether seer's target was a werewolf
      let seerResult: boolean | null = null;
      if (state.seerTarget) {
        seerResult = GameEngine.getSeerResult(state, state.seerTarget);
      }
      state.gameLog.push({
        type: 'night_result',
        round: state.round,
        werewolfTarget: this.resolveUsername(state, state.werewolfTarget),
        bodyguardTarget: this.resolveUsername(state, state.bodyguardTarget),
        seerTarget: this.resolveUsername(state, state.seerTarget),
        seerResult,
        witchHeal: !!state.witch.healTarget,
        witchPoisonTarget: this.resolveUsername(
          state,
          state.witch.poisonTarget,
        ),
        deaths: result.deaths.map((d) => ({
          username:
            state.players.find((p) => p.id === d.playerId)?.username ??
            d.playerId,
          cause: d.cause,
        })),
        saved,
      });

      GameEngine.resetNightState(state);

      // Use injectable delayFn for testability
      void this.delayFn(3000).then(() => {
        this.startDayPhase(roomId);
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

    const result: VotingResult = GameEngine.resolveVoting(state);
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
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:gameEnded', {
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

      this.emitToAllPlayers(roomId, 'votingResult', {
        eliminatedPlayerId: null,
        cause: result.cause,
        tiedPlayerIds: result.tiedPlayerIds,
      });

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:votingAction', {
          type: 'votingAction',
          message,
        });
      }

      GameEngine.resetVotingState(state);

      const winner = this.checkWinCondition(roomId);
      if (!winner) {
        void this.delayFn(3000).then(() => {
          this.startNightPhase(roomId);
        });
      }
      return;
    }

    // Hunter voted out — wait for their shoot action
    if (result.cause === 'hunter') {
      state.hunterShooting = true;
      state.hunterDeathContext = 'vote';
      this.emitToAllPlayers(roomId, 'votingResult', {
        eliminatedPlayerId: result.eliminatedPlayerId,
        cause: 'hunter',
      });
      return;
    }

    // Normal elimination
    state.phase = 'conclude';
    const eliminated = state.players.find(
      (p) => p.id === result.eliminatedPlayerId,
    );

    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:votingAction', {
        type: 'votingAction',
        message: `Người chơi ${eliminated?.username} bị loại.`,
      });
    }

    this.emitToAllPlayers(roomId, 'votingResult', {
      eliminatedPlayerId: result.eliminatedPlayerId,
      cause: 'vote',
    });

    GameEngine.resetVotingState(state);

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      void this.delayFn(3000).then(() => {
        this.startNightPhase(roomId);
      });
    }
  }

  // --- Phase transitions ---

  async startNightPhase(roomId: string) {
    if (!this.acquireTransitionLock(roomId)) return;

    try {
      const state = this.gameStates.get(roomId);
      if (!state) return;

      GameEngine.prepareNightPhase(state);
      this.emitToAllPlayers(roomId, 'game:phaseChanged', {
        phase: 'night',
      });

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: 'nightStart',
          action: 'start',
          message: 'Đêm đến, tất cả mọi người nhắm mắt lại.',
          timestamp: Date.now(),
        });
      }

      await this.delay(2000);

      const roles = ['bodyguard', 'werewolf', 'witch', 'seer'];

      for (const role of roles) {
        const aliveRolePlayers = GameEngine.getPlayersByRole(state, role);
        const isRoleActive = aliveRolePlayers.length > 0;

        state.currentNightStep = role as GameState['currentNightStep'];

        // GM always sees role start (reads the script aloud)
        if (state.gmRoomId) {
          this.emitToGM(state.gmRoomId, 'gm:nightAction', {
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

        // GM always sees role complete (reads "go back to sleep")
        if (state.gmRoomId) {
          this.emitToGM(state.gmRoomId, 'gm:nightAction', {
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

    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:votingAction', {
        type: 'phaseChanged',
        message: 'Mời các bạn bàn luận',
      });
    }
  }

  startVotingPhase(roomId: string): void {
    if (!this.acquireTransitionLock(roomId)) return;

    try {
      const state = this.gameStates.get(roomId);
      if (!state) return;

      state.phase = 'voting';
      state.actionsReceived = new Set();
      state.votes = {};
      state.votingResolved = false;
      state.hunterShooting = false;

      const votingDuration = process.env.NODE_ENV === 'test' ? 1000 : 60000;
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
            this.emitToGM(state.gmRoomId, 'gm:votingAction', {
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
        this.emitToGM(state.gmRoomId, 'gm:votingAction', {
          type: 'phaseChanged',
          message:
            'Chuyển sang giai đoạn bỏ phiếu, các bạn có 1 phút để bỏ phiếu.',
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

      if (state.gmRoomId) {
        const winnerDisplayName =
          winner === 'villagers'
            ? 'Dân làng'
            : winner === 'werewolves'
              ? 'Sói'
              : 'Chán đời';
        this.emitToGM(state.gmRoomId, 'gm:gameEnded', {
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

    if (!responded.has(playerId)) {
      responded.add(playerId);
      responses.push({ playerId, payload });

      if (responded.size === rolePlayers.length) {
        resolve(responses);
        this.pendingResponses.delete(roomId);
      }
    }
  }

  handleVotingResponse(roomId: string, playerId: string, targetId: string) {
    const state = this.gameStates.get(roomId);
    if (!state || state.phase !== 'voting') return;
    // Prevent double-trigger: if voting already resolved, ignore
    if (state.votingResolved) return;

    GameEngine.recordVote(state, playerId, targetId);

    // Resolve early when every alive player has voted
    const alivePlayers = state.players.filter((p) => p.alive);
    const votedCount = state.actionsReceived?.size ?? 0;
    if (votedCount >= alivePlayers.length) {
      if (state.phaseTimeout) {
        clearTimeout(state.phaseTimeout);
        state.phaseTimeout = undefined;
      }
      this.handleVoting(roomId);
    }
  }

  // --- Hunter ---

  handleHunterShoot(roomId: string, targetId: string) {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    const success = GameEngine.applyHunterShoot(state, targetId);
    if (!success) return;

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
    });

    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:hunterAction', {
        type: 'hunterShot',
        message: `Thợ săn đã bắn ${target?.username}.`,
        targetId,
      });
    }

    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      const context = state.hunterDeathContext;
      state.hunterShooting = false;
      state.hunterDeathContext = undefined;
      setTimeout(() => {
        if (context === 'night') {
          void this.startDayPhase(roomId);
        } else {
          void this.startNightPhase(roomId);
        }
      }, 3000);
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

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:hunterAction', {
          type: 'hunterSkipped',
          message: `Thợ săn đã bỏ qua lượt bắn.`,
        });
      }

      const winner = this.checkWinCondition(roomId);
      if (!winner) {
        const context = state.hunterDeathContext;
        state.hunterShooting = false;
        state.hunterDeathContext = undefined;
        void this.delayFn(3000).then(
          () => {
            if (context === 'night') {
              void this.startDayPhase(roomId);
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

  /** Remove all in-memory state for a room (called when the room is cleaned up). */
  cleanupRoom(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (state?.phaseTimeout) clearTimeout(state.phaseTimeout);
    this.gameStates.delete(roomId);

    const pending = this.pendingResponses.get(roomId);
    if (pending) {
      // Resolve with empty array so any awaiting promise unblocks
      pending.resolve([]);
      this.pendingResponses.delete(roomId);
    }

    this.releaseTransitionLock(roomId);
  }

  // --- Init ---

  initGameState(roomId: string, players: Player[], gmRoomId?: string): void {
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
  ): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const player = state.players.find(
      (p) =>
        (p as Player & { persistentId?: string }).persistentId === persistentId,
    );
    if (player) {
      player.id = newSocketId;
    }
  }
}
