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
  currentNightStep?: 'bodyguard' | 'werewolf' | 'witch' | 'seer';
  werewolfVotes?: Record<string, string>;
  gmRoomId?: string;
}

export interface RoleResponse {
  targetId?: string;
  heal?: boolean;
  poisonTargetId?: string;
  vote?: string;
}

export interface NightDeathResult {
  deaths: Array<{ playerId: string; cause: string }>;
}

export interface VotingResult {
  eliminatedPlayerId: string | null;
  cause: 'vote' | 'hunter' | 'tie' | 'no_votes';
  tiedPlayerIds?: string[];
  isTanner?: boolean;
}

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  werewolf: 'Sói',
  seer: 'Tiên tri',
  witch: 'Phù thủy',
  bodyguard: 'Bảo vệ',
  hunter: 'Thợ săn',
  tanner: 'Chán đời',
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  null: ['night'],
  night: ['day', 'ended'],
  day: ['voting'],
  voting: ['conclude', 'ended'],
  conclude: ['night'],
};

export class GameEngine {
  static createInitialState(
    players: Player[],
    gmRoomId?: string,
  ): GameState {
    return {
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
  }

  static prepareNightPhase(state: GameState): void {
    state.werewolfTarget = undefined;
    state.seerTarget = undefined;
    state.bodyguardTarget = undefined;
    state.witch.healTarget = undefined;
    state.witch.poisonTarget = undefined;
    state.phase = 'night';
    state.actionsReceived = new Set();
    state.currentNightStep = undefined;
    state.werewolfVotes = {};
  }

  static getPlayersByRole(state: GameState, role: string): Player[] {
    return state.players.filter((p) => p.alive && p.role === role);
  }

  static getRoleDisplayName(role: string): string {
    return ROLE_DISPLAY_NAMES[role] || role;
  }

  static canTransition(state: GameState, targetPhase: Phase): boolean {
    const currentKey = state.phase === null ? 'null' : state.phase;
    const validTargets = VALID_TRANSITIONS[currentKey];
    return validTargets ? validTargets.includes(targetPhase) : false;
  }

  // --- Night action candidates ---

  static getBodyguardCandidates(
    state: GameState,
  ): Array<{ id: string; username: string }> {
    return state.players
      .filter((p) => p.alive && p.id !== state.lastProtected)
      .map((p) => ({ id: p.id, username: p.username }));
  }

  static getWerewolfCandidates(
    state: GameState,
  ): Array<{ id: string; username: string }> {
    return state.players
      .filter((p) => p.alive && p.role !== 'werewolf')
      .map((p) => ({ id: p.id, username: p.username }));
  }

  static getSeerCandidates(
    state: GameState,
  ): Array<{ id: string; username: string }> {
    return state.players
      .filter((p) => p.alive && p.role !== 'seer')
      .map((p) => ({ id: p.id, username: p.username }));
  }

  /** Returns true if the target is a werewolf — sent back only after the seer confirms their pick. */
  static getSeerResult(state: GameState, targetId: string): boolean {
    const target = state.players.find((p) => p.id === targetId);
    return target?.role === 'werewolf' ?? false;
  }

  static getWitchActionData(state: GameState) {
    return {
      killedPlayerId: state.werewolfTarget,
      canHeal: !state.witch.healUsed,
      canPoison: !state.witch.poisonUsed,
      candidates: state.players
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, username: p.username })),
    };
  }

  // --- Apply night actions ---

  static applyBodyguardAction(state: GameState, targetId?: string): void {
    if (targetId) {
      state.bodyguardTarget = targetId;
      state.lastProtected = targetId;
    }
  }

  static applyWerewolfVotes(
    state: GameState,
    responses: Array<{ playerId: string; payload: RoleResponse }>,
  ): void {
    const votes: Record<string, string> = {};
    responses.forEach((res) => {
      if (res.payload.targetId) {
        votes[res.playerId] = res.payload.targetId;
      }
    });

    const voteCounts: Record<string, number> = {};
    Object.values(votes).forEach((targetId) => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    if (Object.keys(voteCounts).length > 0) {
      const mostVoted = Object.entries(voteCounts).reduce((a, b) =>
        a[1] > b[1] ? a : b,
      );
      state.werewolfTarget = mostVoted[0];
    }
  }

  static applySeerAction(state: GameState, targetId?: string): void {
    if (targetId) {
      state.seerTarget = targetId;
    }
  }

  static applyWitchAction(
    state: GameState,
    heal?: boolean,
    poisonTargetId?: string,
  ): void {
    if (heal) {
      state.witch.healUsed = true;
      state.witch.healTarget = state.werewolfTarget;
    }
    if (poisonTargetId) {
      state.witch.poisonUsed = true;
      state.witch.poisonTarget = poisonTargetId;
    }
  }

  // --- Night resolution ---

  static resolveNightActions(state: GameState): NightDeathResult {
    const deaths: Array<{ playerId: string; cause: string }> = [];
    let werewolfTarget = state.werewolfTarget;

    // Bodyguard protection
    if (state.bodyguardTarget && state.bodyguardTarget === werewolfTarget) {
      werewolfTarget = undefined;
    }

    // Witch heal
    if (
      state.witch.healTarget &&
      state.witch.healTarget === state.werewolfTarget
    ) {
      werewolfTarget = undefined;
    }

    // Werewolf kill (if not protected/healed)
    if (werewolfTarget) {
      deaths.push({ playerId: werewolfTarget, cause: 'werewolf' });
    }

    // Witch poison (independent of werewolf kill)
    if (state.witch.poisonTarget) {
      if (!deaths.find((d) => d.playerId === state.witch.poisonTarget)) {
        deaths.push({ playerId: state.witch.poisonTarget, cause: 'witch' });
      }
    }

    // Mark players as dead
    for (const death of deaths) {
      const player = state.players.find((p) => p.id === death.playerId);
      if (player) {
        player.alive = false;
      }
    }

    return { deaths };
  }

  // --- Voting ---

  static recordVote(
    state: GameState,
    playerId: string,
    targetId: string,
  ): void {
    if (!state.actionsReceived) {
      state.actionsReceived = new Set();
    }
    // Dead players cannot vote
    const voter = state.players.find((p) => p.id === playerId);
    if (!voter?.alive) return;

    if (!state.actionsReceived.has(playerId)) {
      state.actionsReceived.add(playerId);
      state.votes[playerId] = targetId;
    }
  }

  static resolveVoting(state: GameState): VotingResult {
    const voteCounts: Record<string, number> = {};
    Object.values(state.votes).forEach((id) => {
      voteCounts[id] = (voteCounts[id] || 0) + 1;
    });

    // No votes case
    if (Object.keys(voteCounts).length === 0) {
      return { eliminatedPlayerId: null, cause: 'no_votes' };
    }

    // Find max vote count
    let maxVotes = 0;
    for (const count of Object.values(voteCounts)) {
      if (count > maxVotes) maxVotes = count;
    }

    // Find all players with max votes
    const topPlayers = Object.entries(voteCounts)
      .filter(([, count]) => count === maxVotes)
      .map(([id]) => id);

    // Tie detection
    if (topPlayers.length > 1) {
      return {
        eliminatedPlayerId: null,
        cause: 'tie',
        tiedPlayerIds: topPlayers,
      };
    }

    const eliminatedId = topPlayers[0];
    const eliminated = state.players.find((p) => p.id === eliminatedId);

    if (eliminated) {
      eliminated.alive = false;

      // Tanner wins immediately when voted out
      if (eliminated.role === 'tanner') {
        state.phase = 'ended';
        return {
          eliminatedPlayerId: eliminatedId,
          cause: 'vote',
          isTanner: true,
        };
      }

      // Hunter gets to shoot
      if (eliminated.role === 'hunter') {
        return { eliminatedPlayerId: eliminatedId, cause: 'hunter' };
      }
    }

    return { eliminatedPlayerId: eliminatedId, cause: 'vote' };
  }

  // --- Win condition ---

  static checkWinCondition(
    state: GameState,
  ): 'villagers' | 'werewolves' | null {
    const alivePlayers = state.players.filter((p) => p.alive);
    const aliveWerewolves = alivePlayers.filter(
      (p) => p.role === 'werewolf',
    );
    const aliveNonWerewolves = alivePlayers.filter(
      (p) => p.role !== 'werewolf',
    );

    if (
      aliveWerewolves.length >= aliveNonWerewolves.length &&
      aliveWerewolves.length > 0
    ) {
      return 'werewolves';
    }

    if (aliveWerewolves.length === 0) {
      return 'villagers';
    }

    return null;
  }

  // --- Hunter ---

  static applyHunterShoot(state: GameState, targetId: string): boolean {
    const target = state.players.find((p) => p.id === targetId);
    if (target) {
      target.alive = false;
      return true;
    }
    return false;
  }

  // --- Default responses (for timeouts) ---

  static getDefaultRoleResponse(
    role: string,
    state: GameState,
  ): RoleResponse {
    switch (role) {
      case 'bodyguard':
        return {};
      case 'werewolf': {
        const candidates = state.players.filter(
          (p) => p.alive && p.role !== 'werewolf',
        );
        if (candidates.length > 0) {
          const randomIndex = Math.floor(Math.random() * candidates.length);
          return { targetId: candidates[randomIndex].id };
        }
        return {};
      }
      case 'witch':
        return { heal: false };
      case 'seer':
        return {};
      default:
        return {};
    }
  }

  // --- State reset helpers ---

  static resetVotingState(state: GameState): void {
    state.votes = {};
    state.actionsReceived = new Set();
    if (state.phaseTimeout) {
      clearTimeout(state.phaseTimeout);
    }
    state.phaseTimeout = undefined;
  }

  static resetNightState(state: GameState): void {
    state.actionsReceived = new Set();
    state.phaseTimeout = undefined;
    state.currentNightStep = undefined;
    state.werewolfVotes = {};
  }
}
