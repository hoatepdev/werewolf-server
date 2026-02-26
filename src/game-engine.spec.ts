import { GameEngine } from '../service/game-engine';
import { Player } from '../types';

function createPlayers(): Player[] {
  return [
    {
      id: 'p1',
      username: 'Alice',
      avatarKey: 1,
      status: 'approved',
      alive: true,
      role: 'werewolf',
    },
    {
      id: 'p2',
      username: 'Bob',
      avatarKey: 2,
      status: 'approved',
      alive: true,
      role: 'werewolf',
    },
    {
      id: 'p3',
      username: 'Charlie',
      avatarKey: 3,
      status: 'approved',
      alive: true,
      role: 'seer',
    },
    {
      id: 'p4',
      username: 'Diana',
      avatarKey: 4,
      status: 'approved',
      alive: true,
      role: 'witch',
    },
    {
      id: 'p5',
      username: 'Eve',
      avatarKey: 5,
      status: 'approved',
      alive: true,
      role: 'bodyguard',
    },
    {
      id: 'p6',
      username: 'Frank',
      avatarKey: 6,
      status: 'approved',
      alive: true,
      role: 'villager',
    },
    {
      id: 'p7',
      username: 'Grace',
      avatarKey: 7,
      status: 'approved',
      alive: true,
      role: 'hunter',
    },
    {
      id: 'p8',
      username: 'Hank',
      avatarKey: 8,
      status: 'approved',
      alive: true,
      role: 'tanner',
    },
  ];
}

describe('GameEngine', () => {
  describe('createInitialState', () => {
    it('should create initial state with all fields', () => {
      const players = createPlayers();
      const state = GameEngine.createInitialState(players, 'gm-room-1');

      expect(state.phase).toBeNull();
      expect(state.players).toHaveLength(8);
      expect(state.gmRoomId).toBe('gm-room-1');
      expect(state.witch.healUsed).toBe(false);
      expect(state.witch.poisonUsed).toBe(false);
      expect(state.votes).toEqual({});
    });
  });

  describe('prepareNightPhase', () => {
    it('should reset night state', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p3';
      state.seerTarget = 'p1';

      GameEngine.prepareNightPhase(state);

      expect(state.phase).toBe('night');
      expect(state.werewolfTarget).toBeUndefined();
      expect(state.seerTarget).toBeUndefined();
      expect(state.bodyguardTarget).toBeUndefined();
      expect(state.werewolfVotes).toEqual({});
    });
  });

  describe('getPlayersByRole', () => {
    it('should return alive players of specified role', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const wolves = GameEngine.getPlayersByRole(state, 'werewolf');
      expect(wolves).toHaveLength(2);
      expect(wolves[0].id).toBe('p1');
      expect(wolves[1].id).toBe('p2');
    });

    it('should exclude dead players', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.players[0].alive = false; // p1 wolf dead

      const wolves = GameEngine.getPlayersByRole(state, 'werewolf');
      expect(wolves).toHaveLength(1);
      expect(wolves[0].id).toBe('p2');
    });
  });

  describe('canTransition', () => {
    it('should allow null -> night', () => {
      const state = GameEngine.createInitialState(createPlayers());
      expect(GameEngine.canTransition(state, 'night')).toBe(true);
    });

    it('should allow day -> voting', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.phase = 'day';
      expect(GameEngine.canTransition(state, 'voting')).toBe(true);
    });

    it('should reject night -> voting', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.phase = 'night';
      expect(GameEngine.canTransition(state, 'voting')).toBe(false);
    });

    it('should allow conclude -> night', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.phase = 'conclude';
      expect(GameEngine.canTransition(state, 'night')).toBe(true);
    });

    it('should reject ended -> anything', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.phase = 'ended';
      expect(GameEngine.canTransition(state, 'night')).toBe(false);
      expect(GameEngine.canTransition(state, 'day')).toBe(false);
    });
  });

  describe('getWerewolfCandidates', () => {
    it('should return alive non-werewolves', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const candidates = GameEngine.getWerewolfCandidates(state);
      expect(candidates).toHaveLength(6);
      expect(candidates.find((c) => c.id === 'p1')).toBeUndefined();
      expect(candidates.find((c) => c.id === 'p2')).toBeUndefined();
    });
  });

  describe('getBodyguardCandidates', () => {
    it('should exclude lastProtected', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.lastProtected = 'p3';
      const candidates = GameEngine.getBodyguardCandidates(state);
      expect(candidates.find((c) => c.id === 'p3')).toBeUndefined();
      expect(candidates).toHaveLength(7);
    });
  });

  describe('getSeerCandidates', () => {
    it('should return non-seer players without revealing roles (no isRedFlag)', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const candidates = GameEngine.getSeerCandidates(state);
      expect(candidates).toHaveLength(7);
      expect(candidates.find((c) => c.id === 'p3')).toBeUndefined(); // seer excluded

      // Verify candidates have only id and username — no role info leaked
      const wolf = candidates.find((c) => c.id === 'p1');
      expect(wolf).toEqual({ id: 'p1', username: 'Alice' });

      const villager = candidates.find((c) => c.id === 'p6');
      expect(villager).toEqual({ id: 'p6', username: 'Frank' });

      // Verify no isRedFlag property
      expect(Object.keys(candidates[0])).toEqual(['id', 'username']);
    });
  });

  describe('applyWerewolfVotes', () => {
    it('should pick target with most votes', () => {
      const state = GameEngine.createInitialState(createPlayers());
      GameEngine.applyWerewolfVotes(state, [
        { playerId: 'p1', payload: { targetId: 'p3' } },
        { playerId: 'p2', payload: { targetId: 'p3' } },
      ]);
      expect(state.werewolfTarget).toBe('p3');
    });

    it('should handle single werewolf', () => {
      const state = GameEngine.createInitialState(createPlayers());
      GameEngine.applyWerewolfVotes(state, [
        { playerId: 'p1', payload: { targetId: 'p6' } },
      ]);
      expect(state.werewolfTarget).toBe('p6');
    });

    it('should pick one target on tie', () => {
      const state = GameEngine.createInitialState(createPlayers());
      GameEngine.applyWerewolfVotes(state, [
        { playerId: 'p1', payload: { targetId: 'p3' } },
        { playerId: 'p2', payload: { targetId: 'p6' } },
      ]);
      // Both have 1 vote, reduce picks the first one it encounters
      expect(state.werewolfTarget).toBeDefined();
    });
  });

  describe('resolveNightActions', () => {
    it('should kill werewolf target', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p3';

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({ playerId: 'p3', cause: 'werewolf' });
      expect(state.players.find((p) => p.id === 'p3')?.alive).toBe(false);
    });

    it('should protect target from werewolf kill via bodyguard', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p3';
      state.bodyguardTarget = 'p3';

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(0);
      expect(state.players.find((p) => p.id === 'p3')?.alive).toBe(true);
    });

    it('should heal werewolf target via witch', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p3';
      state.witch.healTarget = 'p3';

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(0);
      expect(state.players.find((p) => p.id === 'p3')?.alive).toBe(true);
    });

    it('should kill both werewolf target and witch poison target', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p6';
      state.witch.poisonTarget = 'p3';

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(2);
      expect(result.deaths).toEqual(
        expect.arrayContaining([
          { playerId: 'p6', cause: 'werewolf' },
          { playerId: 'p3', cause: 'witch' },
        ]),
      );
      expect(state.players.find((p) => p.id === 'p6')?.alive).toBe(false);
      expect(state.players.find((p) => p.id === 'p3')?.alive).toBe(false);
    });

    it('should not duplicate death if witch poisons same target as werewolf', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.werewolfTarget = 'p3';
      state.witch.poisonTarget = 'p3';

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({ playerId: 'p3', cause: 'werewolf' });
    });

    it('should result in no deaths when no targets', () => {
      const state = GameEngine.createInitialState(createPlayers());

      const result = GameEngine.resolveNightActions(state);

      expect(result.deaths).toHaveLength(0);
    });
  });

  describe('resolveVoting', () => {
    it('should eliminate player with most votes', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = { p3: 'p1', p4: 'p1', p5: 'p1', p6: 'p2' };

      const result = GameEngine.resolveVoting(state);

      expect(result.eliminatedPlayerId).toBe('p1');
      expect(result.cause).toBe('vote');
      expect(state.players.find((p) => p.id === 'p1')?.alive).toBe(false);
    });

    it('should return tie when multiple players have equal max votes', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = { p3: 'p1', p4: 'p2' };

      const result = GameEngine.resolveVoting(state);

      expect(result.eliminatedPlayerId).toBeNull();
      expect(result.cause).toBe('tie');
      expect(result.tiedPlayerIds).toEqual(
        expect.arrayContaining(['p1', 'p2']),
      );
      // No one should be dead
      expect(state.players.find((p) => p.id === 'p1')?.alive).toBe(true);
      expect(state.players.find((p) => p.id === 'p2')?.alive).toBe(true);
    });

    it('should return no_votes when no one voted', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = {};

      const result = GameEngine.resolveVoting(state);

      expect(result.eliminatedPlayerId).toBeNull();
      expect(result.cause).toBe('no_votes');
    });

    it('should detect tanner win', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = { p1: 'p8', p2: 'p8', p3: 'p8' }; // p8 = tanner

      const result = GameEngine.resolveVoting(state);

      expect(result.eliminatedPlayerId).toBe('p8');
      expect(result.isTanner).toBe(true);
      expect(state.phase).toBe('ended');
    });

    it('should detect hunter elimination', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = { p1: 'p7', p2: 'p7', p3: 'p7' }; // p7 = hunter

      const result = GameEngine.resolveVoting(state);

      expect(result.eliminatedPlayerId).toBe('p7');
      expect(result.cause).toBe('hunter');
    });
  });

  describe('checkWinCondition', () => {
    it('should return null when game continues', () => {
      const state = GameEngine.createInitialState(createPlayers());
      expect(GameEngine.checkWinCondition(state)).toBeNull();
    });

    it('should detect villagers win when all wolves dead', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.players[0].alive = false; // p1 wolf
      state.players[1].alive = false; // p2 wolf

      expect(GameEngine.checkWinCondition(state)).toBe('villagers');
    });

    it('should detect werewolves win when wolves >= non-wolves', () => {
      const state = GameEngine.createInitialState(createPlayers());
      // Kill 4 non-wolves, leaving 2 wolves vs 2 non-wolves
      state.players[2].alive = false; // seer
      state.players[3].alive = false; // witch
      state.players[4].alive = false; // bodyguard
      state.players[5].alive = false; // villager

      expect(GameEngine.checkWinCondition(state)).toBe('werewolves');
    });

    it('should return null when wolves < non-wolves', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.players[5].alive = false; // one villager dead

      expect(GameEngine.checkWinCondition(state)).toBeNull();
    });
  });

  describe('applyHunterShoot', () => {
    it('should mark target as dead', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const success = GameEngine.applyHunterShoot(state, 'p1');
      expect(success).toBe(true);
      expect(state.players.find((p) => p.id === 'p1')?.alive).toBe(false);
    });

    it('should return false for invalid target', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const success = GameEngine.applyHunterShoot(state, 'nonexistent');
      expect(success).toBe(false);
    });
  });

  describe('getDefaultRoleResponse', () => {
    it('should return empty for bodyguard (skip)', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const response = GameEngine.getDefaultRoleResponse('bodyguard', state);
      expect(response).toEqual({});
    });

    it('should return random target for werewolf', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const response = GameEngine.getDefaultRoleResponse('werewolf', state);
      expect(response.targetId).toBeDefined();
      // Target should be a non-werewolf
      const target = state.players.find((p) => p.id === response.targetId);
      expect(target?.role).not.toBe('werewolf');
    });

    it('should return no heal for witch', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const response = GameEngine.getDefaultRoleResponse('witch', state);
      expect(response).toEqual({ heal: false });
    });

    it('should return empty for seer (skip)', () => {
      const state = GameEngine.createInitialState(createPlayers());
      const response = GameEngine.getDefaultRoleResponse('seer', state);
      expect(response).toEqual({});
    });
  });

  describe('recordVote', () => {
    it('should record a vote', () => {
      const state = GameEngine.createInitialState(createPlayers());
      GameEngine.recordVote(state, 'p3', 'p1');
      expect(state.votes['p3']).toBe('p1');
    });

    it('should not allow double voting', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.actionsReceived = new Set();
      GameEngine.recordVote(state, 'p3', 'p1');
      GameEngine.recordVote(state, 'p3', 'p2'); // should be ignored
      expect(state.votes['p3']).toBe('p1');
    });
  });

  describe('resetVotingState', () => {
    it('should clear votes and actions', () => {
      const state = GameEngine.createInitialState(createPlayers());
      state.votes = { p3: 'p1' };
      state.actionsReceived = new Set(['p3']);

      GameEngine.resetVotingState(state);

      expect(state.votes).toEqual({});
      expect(state.actionsReceived?.size).toBe(0);
    });
  });

  describe('getRoleDisplayName', () => {
    it('should return Vietnamese role names', () => {
      expect(GameEngine.getRoleDisplayName('werewolf')).toBe('Sói');
      expect(GameEngine.getRoleDisplayName('seer')).toBe('Tiên tri');
      expect(GameEngine.getRoleDisplayName('witch')).toBe('Phù thủy');
      expect(GameEngine.getRoleDisplayName('bodyguard')).toBe('Bảo vệ');
      expect(GameEngine.getRoleDisplayName('hunter')).toBe('Thợ săn');
    });

    it('should return raw role for unknown roles', () => {
      expect(GameEngine.getRoleDisplayName('unknown')).toBe('unknown');
    });
  });
});
