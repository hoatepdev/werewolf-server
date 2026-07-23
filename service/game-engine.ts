import { Phase, Player } from '../types';

export interface TimerInfo {
  context: 'cupid' | 'bodyguard' | 'werewolf' | 'witch' | 'seer' | 'voting';
  durationMs: number;
  deadline: number;
}

export type VotingChoice = 'target' | 'abstain';

export interface VotingResponse {
  voterId: string;
  choice: VotingChoice;
  targetId: string | null;
  receivedAt: number;
}

export interface RecordVoteResult {
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?:
    | 'not_alive'
    | 'already_responded'
    | 'invalid_choice'
    | 'invalid_target';
  response?: VotingResponse;
}

export interface GmActionLogEntry {
  type: 'nightAction' | 'votingAction' | 'hunterAction' | 'gameEnded';
  message: string;
  timestamp: number;
  step?: string;
  action?: string;
  winner?: 'villagers' | 'werewolves' | 'tanner';
}

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
  votingResponses?: Map<string, VotingResponse>;
  hunterTarget?: string;
  lastProtected?: string;
  phaseTimeout?: NodeJS.Timeout;
  actionsReceived?: Set<string>;
  currentNightStep?: 'cupid' | 'bodyguard' | 'werewolf' | 'witch' | 'seer';
  werewolfVotes?: Record<string, string>;
  gmRoomId?: string;
  votingResolved?: boolean;
  hunterShooting?: boolean;
  hunterDeathContext?: 'night' | 'vote';
  timerInfo?: TimerInfo;
  gameLog: GameLogEntry[];
  gmActionLog: GmActionLogEntry[];
  lastVotingResult?: unknown;
  winner?: 'villagers' | 'werewolves' | 'tanner';
  round: number;
  lovers?: [string, string];
  cupidTargetIds?: [string, string];
  cupidUsed: boolean;
}

export interface RoleResponse {
  targetId?: string;
  targetIds?: string[];
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
  additionalDeaths?: Array<{ playerId: string; cause: 'lover' }>;
  hunterDeathPlayerId?: string;
}

// --- Narrative Log Types ---

export interface NightLogEntry {
  type: 'night_result';
  round: number;
  werewolfTarget: string | null;
  bodyguardTarget: string | null;
  seerTarget: string | null;
  seerResult: boolean | null;
  witchHeal: boolean;
  witchPoisonTarget: string | null;
  deaths: Array<{ username: string; cause: string }>;
  saved: string[];
}

export interface VotingLogEntry {
  type: 'voting_result';
  round: number;
  votes: Array<{ voter: string; target: string }>;
  eliminatedPlayer: string | null;
  cause: 'vote' | 'hunter' | 'tie' | 'no_votes';
  tiedPlayers?: string[];
}

export interface HunterShotLogEntry {
  type: 'hunter_shot';
  round: number;
  hunter: string;
  target: string | null;
}

export interface GameEndLogEntry {
  type: 'game_end';
  round: number;
  winner: 'villagers' | 'werewolves' | 'tanner';
  totalRounds: number;
  players: Array<{ username: string; role: string; alive: boolean }>;
}

export type GameLogEntry =
  | NightLogEntry
  | VotingLogEntry
  | HunterShotLogEntry
  | GameEndLogEntry;

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  werewolf: 'Sói',
  seer: 'Tiên tri',
  witch: 'Phù thủy',
  bodyguard: 'Bảo vệ',
  hunter: 'Thợ săn',
  tanner: 'Chán đời',
  cupid: 'Thần tình yêu',
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  null: ['night'],
  night: ['day', 'ended'],
  day: ['voting'],
  voting: ['conclude', 'ended'],
  conclude: ['night'],
};

export class GameEngine {
  static createInitialState(players: Player[], gmRoomId?: string): GameState {
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
      gameLog: [],
      gmActionLog: [],
      round: 0,
      cupidUsed: false,
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
    state.round = (state.round || 0) + 1;
  }

  static getPlayersByRole(state: GameState, role: string): Player[] {
    return state.players.filter((p) => p.alive && p.role === role);
  }

  static getRoleDisplayName(role: string): string {
    return ROLE_DISPLAY_NAMES[role] || role;
  }

  private static validatePlayerId(state: GameState, playerId: string): boolean {
    return state.players.some((p) => p.id === playerId);
  }

  private static isAlivePlayer(state: GameState, playerId: string): boolean {
    return state.players.some((p) => p.id === playerId && p.alive);
  }

  static isValidAlivePlayer(state: GameState, playerId: string): boolean {
    return this.isAlivePlayer(state, playerId);
  }

  private static candidateIds(
    candidates: Array<{ id: string; username: string }>,
  ): Set<string> {
    return new Set(candidates.map((candidate) => candidate.id));
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

  static getCupidCandidates(
    state: GameState,
  ): Array<{ id: string; username: string }> {
    return state.players
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, username: p.username }));
  }

  /** Returns true if the target is a werewolf — sent back only after the seer confirms their pick. */
  static getSeerResult(state: GameState, targetId: string): boolean {
    const target = state.players.find((p) => p.id === targetId);
    return target?.role === 'werewolf' ? true : false;
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
    if (targetId && !this.validatePlayerId(state, targetId)) {
      return; // Silently skip invalid target
    }
    if (targetId) {
      state.bodyguardTarget = targetId;
      state.lastProtected = targetId;
    }
  }

  static applyCupidAction(state: GameState, targetIds?: string[]): void {
    if (state.cupidUsed || !targetIds || targetIds.length !== 2) {
      return;
    }

    const [firstId, secondId] = targetIds;
    if (firstId === secondId) {
      return;
    }

    if (!this.isAlivePlayer(state, firstId) || !this.isAlivePlayer(state, secondId)) {
      return;
    }

    state.lovers = [firstId, secondId];
    state.cupidTargetIds = [firstId, secondId];
    state.cupidUsed = true;
  }

  static getLoverPartnerId(state: GameState, playerId: string): string | undefined {
    if (!state.lovers) return undefined;
    const [firstId, secondId] = state.lovers;
    if (playerId === firstId) return secondId;
    if (playerId === secondId) return firstId;
    return undefined;
  }

  static applyLoverDeaths(
    state: GameState,
    deaths: Array<{ playerId: string; cause: string }>,
  ): Array<{ playerId: string; cause: string }> {
    const allDeaths = [...deaths];

    for (const death of deaths) {
      const partnerId = this.getLoverPartnerId(state, death.playerId);
      if (
        partnerId &&
        this.isAlivePlayer(state, partnerId) &&
        !allDeaths.some((existing) => existing.playerId === partnerId)
      ) {
        allDeaths.push({ playerId: partnerId, cause: 'lover' });
      }
    }

    for (const death of allDeaths) {
      const player = state.players.find((p) => p.id === death.playerId);
      if (player) {
        player.alive = false;
      }
    }

    return allDeaths;
  }

  static applyWerewolfVotes(
    state: GameState,
    responses: Array<{ playerId: string; payload: RoleResponse }>,
  ): void {
    const validTargets = this.candidateIds(this.getWerewolfCandidates(state));
    const votes: Record<string, string> = {};
    responses.forEach((res) => {
      if (res.payload.targetId && validTargets.has(res.payload.targetId)) {
        votes[res.playerId] = res.payload.targetId;
      }
    });

    const voteCounts: Record<string, number> = {};
    Object.values(votes).forEach((targetId) => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    if (Object.keys(voteCounts).length > 0) {
      let maxVotes = 0;
      for (const count of Object.values(voteCounts)) {
        if (count > maxVotes) maxVotes = count;
      }

      const topTargets = Object.entries(voteCounts)
        .filter(([, count]) => count === maxVotes)
        .map(([targetId]) => targetId);
      const randomIndex = Math.floor(Math.random() * topTargets.length);
      state.werewolfTarget = topTargets[randomIndex];
    }
  }

  static applySeerAction(state: GameState, targetId?: string): void {
    if (targetId && !this.validatePlayerId(state, targetId)) {
      return; // Silently skip invalid target
    }
    if (targetId) {
      state.seerTarget = targetId;
    }
  }

  static applyWitchAction(
    state: GameState,
    heal?: boolean,
    poisonTargetId?: string,
  ): void {
    if (heal && state.werewolfTarget) {
      state.witch.healUsed = true;
      state.witch.healTarget = state.werewolfTarget;
    }
    if (poisonTargetId && this.isAlivePlayer(state, poisonTargetId)) {
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
    if (werewolfTarget && this.isAlivePlayer(state, werewolfTarget)) {
      deaths.push({ playerId: werewolfTarget, cause: 'werewolf' });
    }

    // Witch poison (independent of werewolf kill)
    if (state.witch.poisonTarget && this.isAlivePlayer(state, state.witch.poisonTarget)) {
      if (!deaths.find((d) => d.playerId === state.witch.poisonTarget)) {
        deaths.push({ playerId: state.witch.poisonTarget, cause: 'witch' });
      }
    }

    return { deaths: this.applyLoverDeaths(state, deaths) };
  }

  // --- Voting ---

  static recordVote(
    state: GameState,
    playerId: string,
    targetId?: string | null,
    choice?: VotingChoice,
  ): RecordVoteResult {
    if (!state.actionsReceived) {
      state.actionsReceived = new Set();
    }
    if (!state.votingResponses) {
      state.votingResponses = new Map();
    }

    const voter = state.players.find((p) => p.id === playerId);
    if (!voter?.alive) {
      return { status: 'rejected', reason: 'not_alive' };
    }

    const existingResponse = state.votingResponses.get(playerId);
    if (existingResponse || state.actionsReceived.has(playerId)) {
      return {
        status: 'duplicate',
        reason: 'already_responded',
        response: existingResponse ?? {
          voterId: playerId,
          choice: state.votes[playerId] ? 'target' : 'abstain',
          targetId: state.votes[playerId] ?? null,
          receivedAt: Date.now(),
        },
      };
    }

    const resolvedChoice: VotingChoice =
      choice ?? (targetId ? 'target' : 'abstain');

    if (resolvedChoice !== 'target' && resolvedChoice !== 'abstain') {
      return { status: 'rejected', reason: 'invalid_choice' };
    }

    if (resolvedChoice === 'target' && (!targetId || !this.isAlivePlayer(state, targetId))) {
      return { status: 'rejected', reason: 'invalid_target' };
    }

    const response: VotingResponse = {
      voterId: playerId,
      choice: resolvedChoice,
      targetId: resolvedChoice === 'target' ? targetId! : null,
      receivedAt: Date.now(),
    };

    state.actionsReceived.add(playerId);
    state.votingResponses.set(playerId, response);
    if (response.choice === 'target' && response.targetId) {
      state.votes[playerId] = response.targetId;
    }

    return { status: 'accepted', response };
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

      const deaths = this.applyLoverDeaths(state, [
        { playerId: eliminatedId, cause: 'vote' },
      ]);
      const additionalDeaths = deaths
        .filter((death) => death.playerId !== eliminatedId && death.cause === 'lover')
        .map((death) => ({ playerId: death.playerId, cause: 'lover' as const }));
      const hunterDeath = deaths.find(
        (death) =>
          state.players.find((p) => p.id === death.playerId)?.role === 'hunter',
      );

      // Hunter gets to shoot if they died by vote or lover heartbreak
      if (hunterDeath) {
        return {
          eliminatedPlayerId: eliminatedId,
          cause: 'hunter',
          additionalDeaths,
          hunterDeathPlayerId: hunterDeath.playerId,
        };
      }

      return {
        eliminatedPlayerId: eliminatedId,
        cause: 'vote',
        additionalDeaths,
      };
    }

    return { eliminatedPlayerId: eliminatedId, cause: 'vote' };
  }

  // --- Win condition ---

  static checkWinCondition(
    state: GameState,
  ): 'villagers' | 'werewolves' | null {
    const alivePlayers = state.players.filter((p) => p.alive);
    const aliveWerewolves = alivePlayers.filter((p) => p.role === 'werewolf');
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
    if (!this.isAlivePlayer(state, targetId)) {
      return false;
    }
    const target = state.players.find((p) => p.id === targetId);
    if (target) {
      target.alive = false;
      return true;
    }
    return false;
  }

  // --- Default responses (for timeouts) ---

  static getDefaultRoleResponse(role: string, state: GameState): RoleResponse {
    switch (role) {
      case 'cupid':
        return {};
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
    state.votingResponses = new Map();
    state.votingResolved = undefined;
    if (state.phaseTimeout) {
      clearTimeout(state.phaseTimeout);
    }
    state.phaseTimeout = undefined;
    state.timerInfo = undefined;
  }

  static resetNightState(state: GameState): void {
    state.actionsReceived = new Set();
    state.phaseTimeout = undefined;
    state.currentNightStep = undefined;
    state.werewolfVotes = {};
    state.timerInfo = undefined;
  }
}
