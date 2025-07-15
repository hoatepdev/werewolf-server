import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { Phase, Player } from '../types';

export interface GameState {
  phase: Phase | null;
  players: Player[];
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

interface RoleResponse {
  targetId?: string;
  heal?: boolean;
  poisonTargetId?: string;
  vote?: string;
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

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getPlayersByRole(state: GameState, role: string): Player[] {
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
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    return new Promise((resolve) => {
      const state = this.gameStates.get(roomId);
      if (!state) return resolve(null);
      const rolePlayers = this.getPlayersByRole(state, role);
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
  ): Promise<Array<{ playerId: string; payload: RoleResponse }> | null> {
    switch (role) {
      case 'werewolf':
        return await this.processWerewolfAction(roomId);
      case 'seer':
        return await this.processSeerAction(roomId);
      case 'witch':
        return await this.processWitchAction(roomId);
      case 'bodyguard':
        return await this.processBodyguardAction(roomId);
      case 'hunter':
        return await this.processHunterAction(roomId);
      default:
        return null;
    }
  }

  private async processWerewolfAction(
    roomId: string,
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
        type: 'werewolf',
      },
    );
    if (response && response.length > 0) {
      const votes: Record<string, string> = {};
      response.forEach((res) => {
        const payload = res.payload;
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
      }
    }
    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processSeerAction(
    roomId: string,
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
    if (response && response.length > 0) {
      const seerResponse = response[0];
      const payload = seerResponse.payload;
      if (payload.targetId) {
        state.seerTarget = payload.targetId;
      }
    }
    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processWitchAction(
    roomId: string,
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
      const payload = witchResponse.payload;
      if (payload.heal) {
        state.witch.healUsed = true;
        state.witch.healTarget = state.werewolfTarget;
      }
      if (payload.poisonTargetId) {
        state.witch.poisonUsed = true;
        state.witch.poisonTarget = payload.poisonTargetId;
      }
    }
    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processBodyguardAction(
    roomId: string,
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
      const payload = bodyguardResponse.payload;
      if (payload.targetId) {
        state.bodyguardTarget = payload.targetId;
        state.lastProtected = payload.targetId;
      }
    }
    return response as Array<{
      playerId: string;
      payload: RoleResponse;
    }> | null;
  }

  private async processHunterAction(
    roomId: string,
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
      const payload = hunterResponse.payload;
      if (payload.targetId) {
        state.hunterTarget = payload.targetId;
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
    const diedPlayerIds = new Set<string>();
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
      diedPlayerIds.add(state.witch.poisonTarget);
      cause = 'witch';
    }
    if (target) {
      diedPlayerIds.add(target);
      cause = 'werewolf';
    }
    const huntersDied = Array.from(diedPlayerIds)
      .map((id) => state.players.find((p) => p.id === id))
      .filter((p) => p && p.role === 'hunter') as Player[];
    for (const id of Array.from(diedPlayerIds)) {
      const player = state.players.find((p) => p.id === id);
      if (player) {
        player.alive = false;
      }
    }
    for (const hunter of huntersDied) {
      if (hunter.id === state.hunterTarget) {
        this.handleHunterShoot(roomId, hunter.id);
      }
    }
    const winner = this.checkWinCondition(roomId);
    if (!winner) {
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: 'nightEnd',
          action: 'end',
          message: `Trời sáng rồi, mời mọi người thức dậy. Hôm qua ${
            Array.from(diedPlayerIds).length > 0
              ? `có ${Array.from(diedPlayerIds).length} người chết, đó là: ${Array.from(
                  diedPlayerIds,
                )
                  .map((id) => state.players.find((p) => p.id === id)?.username)
                  .join(', ')}.`
              : `không có người chết.`
          } Mời mọi người bàn luận.`,
          timestamp: Date.now(),
        });
      }
      this.emitToAllPlayers(roomId, 'game:nightResult', {
        diedPlayerIds: Array.from(diedPlayerIds),
        cause,
      });
      state.actionsReceived = new Set();
      state.phaseTimeout = undefined;
      state.currentNightStep = undefined;
      state.werewolfVotes = {};
      setTimeout(() => {
        this.startDayPhase(roomId);
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
      if (state.hunterTarget) {
        this.handleHunterShoot(roomId, state.hunterTarget);
      }
      return;
    }
    state.phase = 'conclude';
    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:votingAction', {
        type: 'votingAction',
        message: `Người chơi ${eliminated?.username} bị loại.`,
      });
    }
    this.emitToAllPlayers(roomId, 'votingResult', {
      eliminatedPlayerId,
      cause,
    });
    state.votes = {};
    state.actionsReceived = new Set();
    state.phaseTimeout = undefined;
  }

  async startNightPhase(roomId: string) {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    state.werewolfTarget = undefined;
    state.seerTarget = undefined;
    state.bodyguardTarget = undefined;
    state.witch.healTarget = undefined;
    state.witch.poisonTarget = undefined;
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

    await this.delay(1000); // cho FE kịp render component

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
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: role,
          action: 'start',
          message: `Xin mời ${this.getRoleDisplayName(role)} thức dậy.`,
          players: rolePlayers.map((p) => ({ id: p.id, username: p.username })),
          timestamp: Date.now(),
        });
      }
      const response = await this.processRoleAction(roomId, role);
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:nightAction', {
          step: role,
          action: 'complete',
          message: `${this.getRoleDisplayName(role)} đã hoàn thành. Vui lòng nhắm mắt lại.`,
          response,
          timestamp: Date.now(),
        });
      }
    }
    this.resolveNightActions(roomId);
  }

  setGmRoom(roomId: string, gmRoomId: string): void {
    const state = this.gameStates.get(roomId);
    if (state) {
      state.gmRoomId = gmRoomId;
    }
  }

  handleRoleResponse(roomId: string, playerId: string, payload: RoleResponse) {
    const pending = this.pendingResponses.get(roomId);
    if (!pending) return;
    const { resolve, responses, responded, rolePlayers } = pending;
    if (!responded.has(playerId)) {
      responded.add(playerId);
      responses.push({ playerId, payload });

      // If this is a hunter response and has targetId, mark the shot player as dead
      const player = rolePlayers.find((p) => p.id === playerId);
      if (player && player.role === 'hunter' && payload.targetId) {
        this.handleHunterShoot(roomId, payload.targetId);
      }
      if (responded.size === rolePlayers.length) {
        resolve(responses);
        this.pendingResponses.delete(roomId);
      }
    }
  }

  handleVotingResponse(roomId: string, playerId: string, targetId: string) {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    if (!state.actionsReceived) {
      state.actionsReceived = new Set();
    }
    if (!state.actionsReceived.has(playerId)) {
      state.actionsReceived.add(playerId);
      state.votes[playerId] = targetId;
    }
  }

  startDayPhase(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    state.phase = 'day';
    this.emitToAllPlayers(roomId, 'game:phaseChanged', { phase: 'day' });
  }

  startVotingPhase(roomId: string): void {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    state.phase = 'voting';
    state.actionsReceived = new Set();
    if (state.phaseTimeout) clearTimeout(state.phaseTimeout);
    state.phaseTimeout = setTimeout(() => {
      // sau 60s sẽ kiểm tra kết quả
      this.handleVoting(roomId);
      const winner = this.checkWinCondition(roomId);
      if (!winner && state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:votingAction', {
          type: 'votingEnded',
          message: 'Bỏ phiếu kết thúc.',
        });
      }
    }, 60000);
    if (state.gmRoomId) {
      this.emitToGM(state.gmRoomId, 'gm:votingAction', {
        type: 'phaseChanged',
        message:
          'Chuyển sang giai đoạn bỏ phiếu, các bạn có 1 phút để bỏ phiếu.',
      });
    }
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
      this.emitToAllPlayers(roomId, 'game:gameEnded', { winner });
      if (state.gmRoomId) {
        this.emitToGM(state.gmRoomId, 'gm:gameEnded', {
          type: 'gameEnded',
          message: `Trò chơi kết thúc. ${winner === 'villagers' ? 'Dân làng' : 'Sói'} thắng!`,
          winner,
        });
      }
    }
    return winner;
  }

  handleHunterShoot(roomId: string, targetId: string) {
    const state = this.gameStates.get(roomId);
    if (!state) return;
    const target = state.players.find((p) => p.id === targetId);
    if (target) target.alive = false;
  }

  initGameState(roomId: string, players: Player[], gmRoomId?: string): void {
    const state: GameState = {
      phase: null,
      players,
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
    this.gameStates.set(roomId, state);
  }
}
