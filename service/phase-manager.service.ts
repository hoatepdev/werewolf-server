import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { Phase, Player } from '../types';

interface RoleResponse {
  targetId?: string;
  heal?: boolean;
  poisonTargetId?: string;
  vote?: string;
}

interface GameState {
  phase: Phase | null;
  players: (Player & { canVote?: boolean })[];
  werewolfTarget?: string;
  seerTarget?: string;
  bodyguardTarget?: string;
  witch: {
    healUsed: boolean;
    poisonUsed: boolean;
    healTarget?: string;
    poisonTarget?: string;
  };
  votes: Record<string, string>;
  hunterTarget?: string;
  lastProtected?: string;
  phaseTimeout?: NodeJS.Timeout;
  actionsReceived?: Set<string>;
  currentNightStep?: 'werewolf' | 'seer' | 'witch' | 'bodyguard' | 'hunter';
  werewolfVotes?: Record<string, string>;
  gmRoomId?: string;
}

@Injectable()
export class PhaseManager {
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

  setServer(server: Server) {
    this.server = server;
  }

  private getPlayersByRole(
    state: GameState,
    role: string,
  ): (Player & { canVote?: boolean })[] {
    return state.players.filter((p) => p.alive && p.role === role);
  }

  private emitToGM(gmRoomId: string, event: string, payload?: any): void {
    if (gmRoomId) {
      this.server.to(gmRoomId).emit(event, payload);
    }
  }

  private emitToAllPlayers(roomId: string, event: string, payload?: any): void {
    this.server.to(roomId).emit(event, payload);
  }

  private async emitToRoleAndWaitResponse(
    roomId: string,
    role: string,
    event: string,
    data: unknown,
  ): Promise<Array<{ playerId: string; payload: unknown }> | null> {
    return new Promise((resolve) => {
      const state = this.gameStates.get(roomId);
      if (!state) return resolve(null);
      const rolePlayers = this.getPlayersByRole(state, role);
      console.log('⭐ rolePlayers', rolePlayers);
      if (rolePlayers.length === 0) return resolve(null);

      const responses: Array<{ playerId: string; payload: RoleResponse }> = [];
      const responded = new Set<string>();

      this.pendingResponses.set(roomId, {
        resolve,
        responses,
        responded,
        rolePlayers,
      });

      rolePlayers.forEach((player) => {
        this.server.to(player.id).emit(event, data);
      });
    });
  }

  private getRoleDisplayName(role: string): string {
    const roleNames = {
      werewolf: 'Sói',
      seer: 'Tiên tri',
      witch: 'Phù thủy',
      bodyguard: 'Bảo vệ',
      hunter: 'Thợ săn',
    };
    return roleNames[role as keyof typeof roleNames];
  }

  private async processRoleAction(
    roomId: string,
    role: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    switch (role) {
      case 'werewolf':
        return await this.processWerewolfAction(roomId, rolePlayers);
      case 'seer':
        return await this.processSeerAction(roomId, rolePlayers);
      case 'witch':
        return await this.processWitchAction(roomId, rolePlayers);
      case 'bodyguard':
        return await this.processBodyguardAction(roomId, rolePlayers);
      case 'hunter':
        return await this.processHunterAction(roomId, rolePlayers);
      default:
        return null;
    }
  }

  private async processWerewolfAction(
    roomId: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const alivePlayers = state.players
      .filter((p) => p.alive && p.role !== 'werewolf')
      .map((p) => ({ id: p.id, username: p.username }));

    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'werewolf',
      'night:werewolf-action',
      {
        message: 'Sói thức dậy, hãy chọn người để cắn.',
        candidates: alivePlayers,
        werewolves: rolePlayers.map((w) => ({
          id: w.id,
          username: w.username,
        })),
        type: 'werewolf',
      },
    );
    console.log('⭐ werewolf response', response);

    if (response && response.length > 0) {
      const votes: Record<string, string> = {};
      response.forEach((res) => {
        const payload = res.payload as RoleResponse;
        if (payload.targetId) {
          votes[res.playerId] = payload.targetId;
        }
      });

      const voteCounts: Record<string, number> = {};
      Object.values(votes).forEach((targetId: string) => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      });

      const mostVoted = Object.entries(voteCounts).reduce((a, b) =>
        voteCounts[a[0]] > voteCounts[b[0]] ? a : b,
      );

      if (mostVoted && mostVoted.length === 2) {
        state.werewolfTarget = mostVoted[0];
        console.log(
          `⭐ Werewolf target: ${mostVoted[0]} with ${mostVoted[1]} votes`,
        );
      }
    }

    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processSeerAction(
    roomId: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const alivePlayers = state.players
      .filter((p) => p.alive && p.role !== 'seer')
      .map((p) => ({
        id: p.id,
        username: p.username,
        isRedFlag: ['werewolf'].includes(p.role || ''),
      }));

    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'seer',
      'night:seer-action',
      {
        message: 'Tiên tri thức dậy, hãy chọn người để xem.',
        candidates: alivePlayers,
        type: 'seer',
      },
    );

    console.log('⭐ seer response', response);

    if (response && response.length > 0) {
      const seerResponse = response[0];
      const payload = seerResponse.payload as RoleResponse;
      if (payload.targetId) {
        state.seerTarget = payload.targetId;
        const targetPlayer = state.players.find(
          (p) => p.id === payload.targetId,
        );
        const isWerewolf = targetPlayer?.role === 'werewolf';
        console.log(
          `⭐ Seer checked ${targetPlayer?.username}: ${isWerewolf ? 'WEREWOLF' : 'NOT WEREWOLF'}`,
        );
      }
    }

    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processWitchAction(
    roomId: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'witch',
      'night:witch-action',
      {
        message: 'Phù thủy thức dậy.',
        killedPlayerId: state.werewolfTarget,
        canHeal: !state.witch.healUsed,
        canPoison: !state.witch.poisonUsed,
        candidates: state.players
          .filter((p) => p.alive)
          .map((p) => ({ id: p.id, username: p.username })),
        type: 'witch',
      },
    );

    if (response && response.length > 0) {
      const witchResponse = response[0];
      const payload = witchResponse.payload as RoleResponse;
      if (payload.heal) {
        state.witch.healUsed = true;
        state.witch.healTarget = state.werewolfTarget;
        console.log(`⭐ Witch healed ${state.werewolfTarget}`);
      }
      if (payload.poisonTargetId) {
        state.witch.poisonUsed = true;
        state.witch.poisonTarget = payload.poisonTargetId;
        console.log(`⭐ Witch poisoned ${payload.poisonTargetId}`);
      }
    }

    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processBodyguardAction(
    roomId: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const alivePlayers = state.players
      .filter((p) => p.alive && p.id !== state.lastProtected)
      .map((p) => ({ id: p.id, username: p.username }));

    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'bodyguard',
      'night:bodyguard-action',
      {
        message: 'Bảo vệ thức dậy, hãy chọn người để bảo vệ.',
        candidates: alivePlayers,
        lastProtected: state.lastProtected,
        type: 'bodyguard',
      },
    );

    if (response && response.length > 0) {
      const bodyguardResponse = response[0];
      const payload = bodyguardResponse.payload as RoleResponse;
      if (payload.targetId) {
        state.bodyguardTarget = payload.targetId;
        state.lastProtected = payload.targetId;
        console.log(`⭐ Bodyguard protected ${payload.targetId}`);
      }
    }

    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processHunterAction(
    roomId: string,
    rolePlayers: Array<{ id: string; username: string; role?: string }>,
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    const alivePlayers = state.players
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, username: p.username }));

    const response = await this.emitToRoleAndWaitResponse(
      roomId,
      'hunter',
      'night:hunter-action',
      {
        message: 'Thợ săn thức dậy, hãy chọn người để bắn (nếu cần).',
        candidates: alivePlayers,
        type: 'hunter',
      },
    );

    if (response && response.length > 0) {
      const hunterResponse = response[0];
      const payload = hunterResponse.payload as RoleResponse;
      if (payload.targetId) {
        state.hunterTarget = payload.targetId;
        console.log(`⭐ Hunter shot ${payload.targetId}`);
      }
    }

    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private resolveNightActions(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;

    const diedPlayerIds: string[] = [];
    let cause: 'werewolf' | 'witch' | 'protected' | 'hunter' = 'werewolf';

    let target = state.werewolfTarget;

    if (state.bodyguardTarget === target) {
      target = undefined;
      cause = 'protected';
    }

    if (
      state.witch.healTarget === state.werewolfTarget &&
      state.witch.healUsed
    ) {
      target = undefined;
      cause = 'protected';
    }

    if (state.witch.poisonTarget && state.witch.poisonUsed) {
      diedPlayerIds.push(state.witch.poisonTarget);
      cause = 'witch';
    }

    if (state.hunterTarget) {
      diedPlayerIds.push(state.hunterTarget);
      cause = 'hunter';
    }

    if (target) {
      diedPlayerIds.push(target);
      cause = 'werewolf';
    }

    for (const id of diedPlayerIds) {
      const player = state.players.find((p) => p.id === id);
      if (player) player.alive = false;
    }

    console.log('⭐ nightResult', { diedPlayerIds, cause });

    const winner = this.checkWinCondition(roomId);

    if (!winner) {
      this.emitToAllPlayers(roomId, 'game:nightResult', {
        diedPlayerIds,
        cause,
      });

      // GM Audio: "Trời sáng rồi, mọi người mở mắt"
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:audio', {
          type: 'nightEnd',
          message: 'Trời sáng rồi, mọi người mở mắt',
          diedPlayerIds,
          cause,
        });
      }

      state.werewolfTarget = undefined;
      state.seerTarget = undefined;
      state.bodyguardTarget = undefined;
      state.witch.healTarget = undefined;
      state.witch.poisonTarget = undefined;
      state.actionsReceived = new Set();
      state.phaseTimeout = undefined;
      state.currentNightStep = undefined;
      state.werewolfVotes = {};

      setTimeout(() => {
        this.startDay(roomId);
      }, 3000);
    }
  }

  private handleVoting(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const voteCounts: Record<string, number> = {};
    Object.values(state.votes).forEach((id) => {
      voteCounts[id] = (voteCounts[id] || 0) + 1;
    });
    let eliminatedPlayerId = '';
    let maxVotes = 0;
    for (const [id, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        eliminatedPlayerId = id;
      }
    }
    const eliminated = state.players.find((p) => p.id === eliminatedPlayerId);
    if (eliminated) eliminated.alive = false;
    const cause: 'vote' | 'hunter' =
      eliminated && eliminated.role === 'hunter' ? 'hunter' : 'vote';
    if (eliminated && eliminated.role === 'hunter') {
      this.server
        .to(roomId)
        .emit('hunterShoot', { hunterId: eliminatedPlayerId });
      return;
    }
    this.emitToAllPlayers(roomId, 'votingResult', {
      eliminatedPlayerId,
      cause,
    });
    state.votes = {};
    state.actionsReceived = new Set();
    state.phaseTimeout = undefined;
  }

  setGmRoom(roomId: string, gmRoomId: string): void {
    const state = this.gameStates.get(roomId);
    if (state) {
      state.gmRoomId = gmRoomId;
    }
  }

  handleRoleResponse(roomId: string, playerId: string, payload: unknown) {
    const pending = this.pendingResponses.get(roomId);
    if (!pending) return;

    const { resolve, responses, responded, rolePlayers } = pending;

    if (!responded.has(playerId)) {
      responded.add(playerId);
      responses.push({ playerId, payload: payload as RoleResponse });

      if (responded.size === rolePlayers.length) {
        console.log(
          `⭐ All ${rolePlayers.length} players responded for room ${roomId}`,
        );
        resolve(responses);
        this.pendingResponses.delete(roomId);
      }
    }
  }

  startDay(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    state.phase = 'day';
    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'day' });
  }

  startVoting(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    state.phase = 'voting';
    state.actionsReceived = new Set();
    if (state.phaseTimeout) clearTimeout(state.phaseTimeout);
    state.phaseTimeout = setTimeout(() => {
      this.handleVoting(roomId);
      this.checkWinCondition(roomId);
      const updatedState = this.gameStates.get(roomId);
      if (updatedState && updatedState.phase !== 'ended') {
        this.handleNightPhase(roomId);
      }
    }, 60000);
    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'voting' });
  }

  checkWinCondition(roomId: string): 'villagers' | 'werewolves' | null {
    const state = this.gameStates.get(roomId);
    if (!state) return null;
    const alivePlayers = state.players.filter((p) => p.alive);
    const werewolves = alivePlayers.filter((p) => p.role === 'werewolf');
    const villagers = alivePlayers.filter((p) => p.role !== 'werewolf');
    let winner: 'villagers' | 'werewolves' | null = null;
    if (werewolves.length === 0) winner = 'villagers';
    if (werewolves.length >= villagers.length) winner = 'werewolves';
    if (winner) {
      state.phase = 'ended';
      this.emitToAllPlayers(roomId, 'gameEnded', { winner });

      // GM Audio: Game ended
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:audio', {
          type: 'gameEnded',
          message: `Trò chơi kết thúc. ${winner === 'villagers' ? 'Dân làng' : 'Sói'} thắng!`,
          winner,
        });
      }
    }
    return winner;
  }

  initGameState(roomId: string, players: Player[], gmRoomId?: string): void {
    const state: GameState = {
      phase: null,
      players: players.map((p) => ({ ...p, canVote: true })),
      werewolfTarget: undefined,
      seerTarget: undefined,
      bodyguardTarget: undefined,
      witch: {
        healUsed: false,
        poisonUsed: false,
        healTarget: undefined,
        poisonTarget: undefined,
      },
      votes: {},
      hunterTarget: undefined,
      lastProtected: undefined,
      gmRoomId,
    };
    console.log('initGameState', { roomId, gmRoomId });
    this.gameStates.set(roomId, state);
  }

  async handleNightPhase(roomId: string) {
    const state = this.gameStates.get(roomId);
    console.log('⭐ state', state);

    if (!state) return;
    state.phase = 'night';
    state.actionsReceived = new Set();
    state.currentNightStep = undefined;
    state.werewolfVotes = {};
    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'night' });

    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:nightAction', {
        step: 'nightStart',
        action: 'start',
        message: 'Đêm đến, tất cả mọi người nhắm mắt lại.',
        timestamp: Date.now(),
      });
    }

    await new Promise((r) => setTimeout(r, 1000));

    const roles = ['werewolf', 'seer', 'witch', 'bodyguard', 'hunter'];

    for (const role of roles) {
      const rolePlayers = this.getPlayersByRole(state, role);
      if (rolePlayers.length === 0) continue;

      state.currentNightStep = role as
        | 'werewolf'
        | 'seer'
        | 'witch'
        | 'bodyguard'
        | 'hunter';
      console.log(`⭐ Processing ${role} turn`);

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: role,
          action: 'start',
          message: `${this.getRoleDisplayName(role)} thức dậy đê.`,
          players: rolePlayers.map((p) => ({ id: p.id, username: p.username })),
          timestamp: Date.now(),
        });
      }

      const response = await this.processRoleAction(roomId, role, rolePlayers);
      console.log(`⭐ ${role} response:`, response);

      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: role,
          action: 'complete',
          message: `${this.getRoleDisplayName(role)} đã hoàn thành. Vui lòng nhắm mắt lại.`,
          response,
          timestamp: Date.now(),
        });
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    this.resolveNightActions(roomId);
  }
}
