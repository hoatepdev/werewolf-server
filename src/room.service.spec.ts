import { RoomService } from '../service/room.service';
import { Player, Role } from '../types';

function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  return {
    avatarKey: 1,
    username: 'TestUser',
    status: 'pending',
    alive: undefined, // Players are not alive until they call ready (except GM)
    ...overrides,
  };
}

describe('RoomService', () => {
  let service: RoomService;

  beforeEach(() => {
    service = new RoomService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  // ── createRoom ───────────────────────────────────────────────────────────────

  describe('createRoom', () => {
    it('should create a room and return it', () => {
      const room = service.createRoom('socket-1', 1, 'GM');

      expect(room).toBeDefined();
      expect(room.roomCode).toBeTruthy();
      expect(room.hostId).toBe('socket-1');
      expect(room.players).toHaveLength(1);
      expect(room.players[0].status).toBe('gm');
      expect(room.players[0].username).toBe('GM');
      expect(room.lastActivityAt).toBeGreaterThan(0);
    });

    it('should store the room and make it retrievable', () => {
      const room = service.createRoom('socket-1', 1, 'GM');
      const retrieved = service.getRoom(room.roomCode);

      expect(retrieved).toBe(room);
    });

    it('should accept a custom room code', () => {
      const room = service.createRoom('socket-1', 1, 'GM', '123456');

      expect(room.roomCode).toBe('123456');
    });

    it('should throw when room code collisions exceed max retries', () => {
      const fixedCode = '111111';
      service.createRoom('socket-1', 1, 'GM', fixedCode);

      // Attempting to create another room with the same fixed code should throw
      expect(() => {
        service.createRoom('socket-2', 2, 'GM2', fixedCode);
      }).toThrow('Unable to generate unique room code');
    });

    it('should generate a 6-digit numeric room code', () => {
      const room = service.createRoom('socket-1', 1, 'GM');

      expect(room.roomCode).toMatch(/^\d{6}$/);
    });

    it('should initialize room with phase=night and round=0', () => {
      const room = service.createRoom('socket-1', 1, 'GM');

      expect(room.phase).toBe('night');
      expect(room.round).toBe(0);
    });

    it('should store GM persistent id on the room and GM player', () => {
      const room = service.createRoom('socket-1', 1, 'GM', undefined, 'gm-pid');

      expect(room.gmPersistentId).toBe('gm-pid');
      expect(room.players[0].persistentId).toBe('gm-pid');
    });
  });

  // ── getRoom ──────────────────────────────────────────────────────────────────

  describe('getRoom', () => {
    it('should return undefined for unknown room code', () => {
      expect(service.getRoom('999999')).toBeUndefined();
    });
  });

  // ── addPlayer ────────────────────────────────────────────────────────────────

  describe('addPlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
    });

    it('should add a new player and return true', () => {
      const player = makePlayer({ id: 'p1' });
      const result = service.addPlayer(roomCode, player);

      expect(result).toBe(true);
      expect(service.getPlayers(roomCode)).toHaveLength(2); // GM + player
    });

    it('should set player status to pending on add', () => {
      const player = makePlayer({ id: 'p1', status: 'approved' });
      service.addPlayer(roomCode, player);

      const added = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(added?.status).toBe('pending');
    });

    it('should reject duplicate socket id', () => {
      const player = makePlayer({ id: 'p1' });
      service.addPlayer(roomCode, player);
      const result = service.addPlayer(
        roomCode,
        makePlayer({ id: 'p1', username: 'Clone' }),
      );

      expect(result).toBe(false);
      expect(service.getPlayers(roomCode)).toHaveLength(2);
    });

    it('should reject duplicate persistentId', () => {
      const player1 = makePlayer({ id: 'socket-a', persistentId: 'pid-1' });
      const player2 = makePlayer({ id: 'socket-b', persistentId: 'pid-1' });

      service.addPlayer(roomCode, player1);
      const result = service.addPlayer(roomCode, player2);

      expect(result).toBe(false);
    });

    it('should allow two players with different persistentIds', () => {
      service.addPlayer(
        roomCode,
        makePlayer({ id: 'sa', persistentId: 'pid-1' }),
      );
      const result = service.addPlayer(
        roomCode,
        makePlayer({ id: 'sb', persistentId: 'pid-2' }),
      );

      expect(result).toBe(true);
    });

    it('should return false for unknown room code', () => {
      const result = service.addPlayer('999999', makePlayer({ id: 'p1' }));
      expect(result).toBe(false);
    });
  });

  // ── rejoinPlayer ─────────────────────────────────────────────────────────────

  describe('rejoinPlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(
        roomCode,
        makePlayer({
          id: 'old-socket',
          persistentId: 'pid-1',
          status: 'pending',
        }),
      );
      service.approvePlayer(roomCode, 'old-socket');
    });

    it('should update socket id and return the player with the previous socket id', () => {
      const result = service.rejoinPlayer(roomCode, 'new-socket', 'pid-1');

      expect(result).not.toBeNull();
      expect(result?.oldSocketId).toBe('old-socket');
      expect(result?.player.id).toBe('new-socket');
    });

    it('should return null for unknown persistentId', () => {
      const player = service.rejoinPlayer(
        roomCode,
        'new-socket',
        'unknown-pid',
      );
      expect(player).toBeNull();
    });

    it('should return null for rejected player', () => {
      service.addPlayer(
        roomCode,
        makePlayer({ id: 'rejected-socket', persistentId: 'pid-rejected' }),
      );
      service.rejectPlayer(roomCode, 'rejected-socket');

      const player = service.rejoinPlayer(
        roomCode,
        'new-socket',
        'pid-rejected',
      );
      expect(player).toBeNull();
    });

    it('should return null for unknown room code', () => {
      const player = service.rejoinPlayer('999999', 'new-socket', 'pid-1');
      expect(player).toBeNull();
    });
  });

  // ── approvePlayer ────────────────────────────────────────────────────────────

  describe('approvePlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
    });

    it('should set player status to approved', () => {
      const result = service.approvePlayer(roomCode, 'p1');

      expect(result).toBe(true);
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.status).toBe('approved');
    });

    it('should initialize approved player readiness to false', () => {
      service.approvePlayer(roomCode, 'p1');

      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.ready).toBe(false);
    });

    it('should return false for non-pending player', () => {
      service.approvePlayer(roomCode, 'p1'); // approve once
      const result = service.approvePlayer(roomCode, 'p1'); // approve again

      expect(result).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.approvePlayer('999999', 'p1')).toBe(false);
    });

    it('should return false for unknown player', () => {
      expect(service.approvePlayer(roomCode, 'nobody')).toBe(false);
    });
  });

  // ── rejectPlayer ─────────────────────────────────────────────────────────────

  describe('rejectPlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
    });

    it('should set player status to rejected', () => {
      const result = service.rejectPlayer(roomCode, 'p1');

      expect(result).toBe(true);
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.status).toBe('rejected');
    });

    it('should return false for already-approved player', () => {
      service.approvePlayer(roomCode, 'p1');
      expect(service.rejectPlayer(roomCode, 'p1')).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.rejectPlayer('999999', 'p1')).toBe(false);
    });
  });

  // ── lifecycle ────────────────────────────────────────────────────────────────

  describe('room lifecycle', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom(
        'gm-socket',
        1,
        'GM',
        undefined,
        'gm-pid',
      );
      roomCode = room.roomCode;
    });

    it('should remove a pending player who leaves', () => {
      service.addPlayer(
        roomCode,
        makePlayer({ id: 'p1', persistentId: 'pid-1' }),
      );
      const token = service.issueReconnectToken(roomCode, 'pid-1');

      const result = service.leavePlayer(roomCode, 'p1');

      expect(result).toEqual(
        expect.objectContaining({ success: true, status: 'removed' }),
      );
      expect(service.getPlayers(roomCode).some((p) => p.id === 'p1')).toBe(
        false,
      );
      expect(service.validateReconnectToken(roomCode, 'pid-1', token)).toBe(
        false,
      );
    });

    it('should remove an approved pre-game player who leaves', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
      service.approvePlayer(roomCode, 'p1');

      const result = service.leavePlayer(roomCode, 'p1');

      expect(result.status).toBe('removed');
      expect(service.getPlayers(roomCode).some((p) => p.id === 'p1')).toBe(
        false,
      );
    });

    it('should mark an active-game player dead without removing them', () => {
      service.addPlayer(
        roomCode,
        makePlayer({ id: 'p1', persistentId: 'pid-1' }),
      );
      service.approvePlayer(roomCode, 'p1');
      service.randomizeRoles(roomCode, ['werewolf']);
      service.playerReady(roomCode, 'p1');
      service.markGameStarted(roomCode);

      const result = service.leavePlayer(roomCode, 'p1');
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');

      expect(result.status).toBe('left_active_game');
      expect(player).toBeDefined();
      expect(player?.alive).toBe(false);
      expect(service.getRoom(roomCode)?.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'player_left' }),
        ]),
      );
    });

    it('should update player info', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));

      const result = service.updatePlayerInfo(roomCode, 'p1', 'Tên mới', 7);

      expect(result.success).toBe(true);
      expect(result.player).toEqual(
        expect.objectContaining({ username: 'Tên mới', avatarKey: 7 }),
      );
    });

    it('should reset room for replay and preserve approved players', () => {
      service.addPlayer(
        roomCode,
        makePlayer({ id: 'p1', persistentId: 'pid-1' }),
      );
      service.addPlayer(roomCode, makePlayer({ id: 'pending' }));
      service.approvePlayer(roomCode, 'p1');
      service.randomizeRoles(roomCode, ['werewolf']);
      service.playerReady(roomCode, 'p1');
      service.markGameStarted(roomCode);

      const room = service.resetRoom(roomCode);
      const player = room?.players.find((p) => p.id === 'p1');

      expect(room?.gameStarted).toBe(false);
      expect(room?.phase).toBe('night');
      expect(room?.round).toBe(0);
      expect(room?.actions).toEqual([]);
      expect(player).toEqual(
        expect.objectContaining({ status: 'approved', ready: false }),
      );
      expect(player?.role).toBeUndefined();
      expect(player?.alive).toBeUndefined();
      expect(room?.players.some((p) => p.id === 'pending')).toBe(false);
    });
  });

  // ── eliminatePlayer ──────────────────────────────────────────────────────────

  describe('eliminatePlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
      service.approvePlayer(roomCode, 'p1');
    });

    it('should set player alive to false and log action', () => {
      const result = service.eliminatePlayer(roomCode, 'p1', 'test reason');

      expect(result).toBe(true);
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.alive).toBe(false);

      const room = service.getRoom(roomCode)!;
      expect(room.actions).toHaveLength(1);
      expect(room.actions[0].type).toBe('gm_elimination');
      expect(room.actions[0].reason).toBe('test reason');
    });

    it('should return false for non-approved player', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'p2' }));
      expect(service.eliminatePlayer(roomCode, 'p2')).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.eliminatePlayer('999999', 'p1')).toBe(false);
    });

    it('should return false for unknown player id', () => {
      expect(service.eliminatePlayer(roomCode, 'nobody')).toBe(false);
    });
  });

  // ── revivePlayer ─────────────────────────────────────────────────────────────

  describe('revivePlayer', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
      service.approvePlayer(roomCode, 'p1');
      service.eliminatePlayer(roomCode, 'p1');
    });

    it('should set player alive to true and log action', () => {
      const result = service.revivePlayer(roomCode, 'p1');

      expect(result).toBe(true);
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.alive).toBe(true);

      const room = service.getRoom(roomCode)!;
      const revivalAction = room.actions.find((a) => a.type === 'gm_revival');
      expect(revivalAction).toBeDefined();
    });

    it('should return false for non-approved player', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'p2' }));
      expect(service.revivePlayer(roomCode, 'p2')).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.revivePlayer('999999', 'p1')).toBe(false);
    });
  });

  // ── randomizeRoles ───────────────────────────────────────────────────────────

  describe('randomizeRoles', () => {
    let roomCode: string;
    const testRoles: Role[] = ['werewolf', 'seer', 'villager'];

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
      service.addPlayer(roomCode, makePlayer({ id: 'p2' }));
      service.addPlayer(roomCode, makePlayer({ id: 'p3' }));
      service.approvePlayer(roomCode, 'p1');
      service.approvePlayer(roomCode, 'p2');
      service.approvePlayer(roomCode, 'p3');
    });

    it('should assign exactly the provided roles to approved players', () => {
      const result = service.randomizeRoles(roomCode, testRoles);

      expect(result).toBe(true);
      const players = service
        .getPlayers(roomCode)
        .filter((p) => p.status === 'approved');
      const assignedRoles = players.map((p) => p.role).sort();
      expect(assignedRoles).toEqual([...testRoles].sort());
    });

    it('should only assign roles to approved players (not GM or pending)', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'pending-player' }));
      // pending-player is not approved

      const result = service.randomizeRoles(roomCode, testRoles);

      expect(result).toBe(true);
      const pendingPlayer = service
        .getPlayers(roomCode)
        .find((p) => p.id === 'pending-player');
      expect(pendingPlayer?.role).toBeUndefined();
    });

    it('should return false when role count does not match approved player count', () => {
      const result = service.randomizeRoles(roomCode, ['werewolf', 'seer']); // 2 roles for 3 players

      expect(result).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.randomizeRoles('999999', testRoles)).toBe(false);
    });

    it('should set room phase to night and round to 1 after randomization', () => {
      service.randomizeRoles(roomCode, testRoles);
      const room = service.getRoom(roomCode)!;

      expect(room.phase).toBe('night');
      expect(room.round).toBe(1);
    });

    it('should reset stale readiness when roles are randomized', () => {
      const players = service
        .getPlayers(roomCode)
        .filter((p) => p.status === 'approved');
      players.forEach((player) => {
        player.ready = true;
        player.alive = true;
      });

      service.randomizeRoles(roomCode, testRoles);

      const updatedPlayers = service
        .getPlayers(roomCode)
        .filter((p) => p.status === 'approved');
      updatedPlayers.forEach((player) => {
        expect(player.ready).toBe(false);
        expect(player.alive).toBeUndefined();
      });
    });

    it('should produce a valid permutation (all roles assigned exactly once)', () => {
      // Run 5 times to increase confidence in shuffle correctness
      for (let i = 0; i < 5; i++) {
        const freshRoom = service.createRoom(`gm-${i}`, 1, 'GM');
        service.addPlayer(freshRoom.roomCode, makePlayer({ id: `a${i}` }));
        service.addPlayer(freshRoom.roomCode, makePlayer({ id: `b${i}` }));
        service.addPlayer(freshRoom.roomCode, makePlayer({ id: `c${i}` }));
        service.approvePlayer(freshRoom.roomCode, `a${i}`);
        service.approvePlayer(freshRoom.roomCode, `b${i}`);
        service.approvePlayer(freshRoom.roomCode, `c${i}`);

        service.randomizeRoles(freshRoom.roomCode, testRoles);
        const players = service
          .getPlayers(freshRoom.roomCode)
          .filter((p) => p.status === 'approved');
        const assignedRoles = players.map((p) => p.role).sort();

        expect(assignedRoles).toEqual([...testRoles].sort());
      }
    });
  });

  // ── playerReady ──────────────────────────────────────────────────────────────

  describe('playerReady', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
      service.addPlayer(roomCode, makePlayer({ id: 'p1' }));
      service.addPlayer(roomCode, makePlayer({ id: 'p2' }));
      service.approvePlayer(roomCode, 'p1');
      service.approvePlayer(roomCode, 'p2');
    });

    it('should not mark player ready before roles are assigned', () => {
      const allReady = service.playerReady(roomCode, 'p1');
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');

      expect(allReady).toBe(false);
      expect(player?.ready).toBe(false);
      expect(player?.alive).toBeUndefined();
    });

    it('should mark player as ready and alive after roles are assigned', () => {
      service.randomizeRoles(roomCode, ['werewolf', 'seer']);

      service.playerReady(roomCode, 'p1');
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.ready).toBe(true);
      expect(player?.alive).toBe(true);
    });

    it('should return false when not all players are ready', () => {
      service.randomizeRoles(roomCode, ['werewolf', 'seer']);

      const allReady = service.playerReady(roomCode, 'p1');
      expect(allReady).toBe(false);
    });

    it('should return true when all approved players are ready', () => {
      service.randomizeRoles(roomCode, ['werewolf', 'seer']);

      service.playerReady(roomCode, 'p1');
      const allReady = service.playerReady(roomCode, 'p2');
      expect(allReady).toBe(true);
    });

    it('should return false for non-approved player', () => {
      service.randomizeRoles(roomCode, ['werewolf', 'seer']);
      service.addPlayer(roomCode, makePlayer({ id: 'p3' }));
      expect(service.playerReady(roomCode, 'p3')).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.playerReady('999999', 'p1')).toBe(false);
    });

    it('should return false once the game has started', () => {
      service.randomizeRoles(roomCode, ['werewolf', 'seer']);
      service.playerReady(roomCode, 'p1');
      expect(service.markGameStarted(roomCode)).toBe(true);

      expect(service.playerReady(roomCode, 'p2')).toBe(false);
    });
  });

  // ── findRoomBySocketId ───────────────────────────────────────────────────────

  describe('findRoomBySocketId', () => {
    it('should find room by host socket id', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');

      expect(service.findRoomBySocketId('gm-socket')).toBe(room.roomCode);
    });

    it('should find room by player socket id', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      service.addPlayer(room.roomCode, makePlayer({ id: 'player-socket' }));

      expect(service.findRoomBySocketId('player-socket')).toBe(room.roomCode);
    });

    it('should return undefined for unknown socket id', () => {
      expect(service.findRoomBySocketId('nobody')).toBeUndefined();
    });
  });

  // ── GM disconnection / reconnection ─────────────────────────────────────────

  describe('GM disconnection flow', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      roomCode = room.roomCode;
    });

    it('should set disconnectedGmId on setGmDisconnected', () => {
      service.setGmDisconnected(roomCode, 'gm-socket');
      const room = service.getRoom(roomCode)!;
      expect(room.disconnectedGmId).toBe('gm-socket');
    });

    it('should detect reconnection when disconnectedGmId is set and new socket differs', () => {
      service.setGmDisconnected(roomCode, 'gm-socket');
      expect(service.isGmReconnection(roomCode, 'new-gm-socket')).toBe(true);
    });

    it('should not detect reconnection for the same socket id', () => {
      service.setGmDisconnected(roomCode, 'gm-socket');
      expect(service.isGmReconnection(roomCode, 'gm-socket')).toBe(false);
    });

    it('should not detect reconnection when no disconnectedGmId is set', () => {
      expect(service.isGmReconnection(roomCode, 'new-socket')).toBe(false);
    });

    it('should update hostId and clear disconnectedGmId on reconnectGm', () => {
      service.setGmDisconnected(roomCode, 'gm-socket');
      service.reconnectGm(roomCode, 'new-gm-socket');

      const room = service.getRoom(roomCode)!;
      expect(room.hostId).toBe('new-gm-socket');
      expect(room.disconnectedGmId).toBeUndefined();
    });

    it('should update hostId and GM player id on credentialed reconnectGm', () => {
      const room = service.createRoom(
        'gm-socket-2',
        1,
        'GM2',
        undefined,
        'gm-pid-2',
      );
      service.setGmDisconnected(room.roomCode, 'gm-socket-2');

      const gm = service.reconnectGm(
        room.roomCode,
        'new-gm-socket',
        'gm-pid-2',
      );

      expect(gm).not.toBeNull();
      expect(gm?.id).toBe('new-gm-socket');
      expect(service.getRoom(room.roomCode)?.hostId).toBe('new-gm-socket');
      expect(service.getRoom(room.roomCode)?.disconnectedGmId).toBeUndefined();
      expect(service.findRoomBySocketId('new-gm-socket')).toBe(room.roomCode);
    });

    it('should reject credentialed reconnectGm with wrong GM persistent id', () => {
      const room = service.createRoom(
        'gm-socket-2',
        1,
        'GM2',
        undefined,
        'gm-pid-2',
      );

      const gm = service.reconnectGm(
        room.roomCode,
        'new-gm-socket',
        'wrong-gm-pid',
      );

      expect(gm).toBeNull();
      expect(service.getRoom(room.roomCode)?.hostId).toBe('gm-socket-2');
    });
  });

  // ── reconnect tokens ─────────────────────────────────────────────────────────

  describe('reconnect tokens', () => {
    it('should issue and validate a reconnect token', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      const token = service.issueReconnectToken(room.roomCode, 'pid-1');

      expect(
        service.validateReconnectToken(room.roomCode, 'pid-1', token),
      ).toBe(true);
      expect(
        service.validateReconnectToken(room.roomCode, 'pid-1', 'wrong-token'),
      ).toBe(false);
    });

    it('should issue and validate a GM reconnect token separately', () => {
      const room = service.createRoom(
        'gm-socket',
        1,
        'GM',
        undefined,
        'gm-pid',
      );
      const token = service.issueGmReconnectToken(room.roomCode, 'gm-pid');

      expect(
        service.validateGmReconnectToken(room.roomCode, 'gm-pid', token),
      ).toBe(true);
      expect(
        service.validateGmReconnectToken(
          room.roomCode,
          'gm-pid',
          'wrong-token',
        ),
      ).toBe(false);
      expect(
        service.validateGmReconnectToken(room.roomCode, 'wrong-gm-pid', token),
      ).toBe(false);
    });

    it('should not validate player reconnect tokens as GM reconnect tokens', () => {
      const room = service.createRoom(
        'gm-socket',
        1,
        'GM',
        undefined,
        'gm-pid',
      );
      const playerToken = service.issueReconnectToken(room.roomCode, 'gm-pid');

      expect(
        service.validateGmReconnectToken(room.roomCode, 'gm-pid', playerToken),
      ).toBe(false);
    });
  });

  // ── GM room routing ──────────────────────────────────────────────────────────

  describe('GM room routing', () => {
    it('should store and return a dedicated GM room id', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');

      service.setGmRoomId(room.roomCode, 'gm-room-1');

      expect(service.getGmRoomId(room.roomCode)).toBe('gm-room-1');
    });
  });

  // ── stale room cleanup ───────────────────────────────────────────────────────

  describe('cleanupStaleRooms (via fake timers)', () => {
    it('should call cleanup callback and remove room after TTL', () => {
      jest.useFakeTimers();

      const freshService = new RoomService();
      const cleanupCb = jest.fn();
      freshService.setOnRoomCleanup(cleanupCb);

      const room = freshService.createRoom('gm-socket', 1, 'GM');
      const code = room.roomCode;

      // Manually expire the room
      const internalRoom = freshService.getRoom(code)!;
      internalRoom.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago

      // Advance past the 10-minute cleanup interval
      jest.advanceTimersByTime(11 * 60 * 1000);

      expect(freshService.getRoom(code)).toBeUndefined();
      expect(cleanupCb).toHaveBeenCalledWith(code);

      freshService.onModuleDestroy();
    });

    it('should not remove active rooms during cleanup', () => {
      jest.useFakeTimers();

      const freshService = new RoomService();
      const room = freshService.createRoom('gm-socket', 1, 'GM');
      const code = room.roomCode;

      jest.advanceTimersByTime(11 * 60 * 1000);

      expect(freshService.getRoom(code)).toBeDefined();

      freshService.onModuleDestroy();
    });
  });

  // ── getPlayers ───────────────────────────────────────────────────────────────

  describe('getPlayers', () => {
    it('should return empty array for unknown room', () => {
      expect(service.getPlayers('999999')).toEqual([]);
    });

    it('should return all players including GM', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      service.addPlayer(room.roomCode, makePlayer({ id: 'p1' }));

      const players = service.getPlayers(room.roomCode);
      expect(players).toHaveLength(2);
    });
  });
});
