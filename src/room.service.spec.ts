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
      const room = service.createRoom('socket-1', 1, 'GM', 'CUSTOMCODE12');

      expect(room.roomCode).toBe('CUSTOMCODE12');
    });

    it('should throw when room code collisions exceed max retries', () => {
      const fixedCode = 'FIXEDCODE123';
      service.createRoom('socket-1', 1, 'GM', fixedCode);

      // Attempting to create another room with the same fixed code should throw
      expect(() => {
        service.createRoom('socket-2', 2, 'GM2', fixedCode);
      }).toThrow('Unable to generate unique room code');
    });

    it('should generate a 12-character alphanumeric room code', () => {
      const room = service.createRoom('socket-1', 1, 'GM');

      expect(room.roomCode).toMatch(/^[A-Z0-9]{12}$/);
    });

    it('should initialize room with phase=night and round=0', () => {
      const room = service.createRoom('socket-1', 1, 'GM');

      expect(room.phase).toBe('night');
      expect(room.round).toBe(0);
    });
  });

  // ── getRoom ──────────────────────────────────────────────────────────────────

  describe('getRoom', () => {
    it('should return undefined for unknown room code', () => {
      expect(service.getRoom('UNKNOWN123456')).toBeUndefined();
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
      const result = service.addPlayer(
        'UNKNOWN123456',
        makePlayer({ id: 'p1' }),
      );
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

    it('should update socket id and return the player', () => {
      const player = service.rejoinPlayer(roomCode, 'new-socket', 'pid-1');

      expect(player).not.toBeNull();
      expect(player?.id).toBe('new-socket');
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
      const player = service.rejoinPlayer(
        'UNKNOWN123456',
        'new-socket',
        'pid-1',
      );
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

    it('should return false for non-pending player', () => {
      service.approvePlayer(roomCode, 'p1'); // approve once
      const result = service.approvePlayer(roomCode, 'p1'); // approve again

      expect(result).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.approvePlayer('UNKNOWN123456', 'p1')).toBe(false);
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
      expect(service.rejectPlayer('UNKNOWN123456', 'p1')).toBe(false);
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
      expect(service.eliminatePlayer('UNKNOWN123456', 'p1')).toBe(false);
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
      expect(service.revivePlayer('UNKNOWN123456', 'p1')).toBe(false);
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
      expect(service.randomizeRoles('UNKNOWN123456', testRoles)).toBe(false);
    });

    it('should set room phase to night and round to 1 after randomization', () => {
      service.randomizeRoles(roomCode, testRoles);
      const room = service.getRoom(roomCode)!;

      expect(room.phase).toBe('night');
      expect(room.round).toBe(1);
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

    it('should mark player as alive when ready', () => {
      service.playerReady(roomCode, 'p1');
      const player = service.getPlayers(roomCode).find((p) => p.id === 'p1');
      expect(player?.alive).toBe(true);
    });

    it('should return false when not all players are ready', () => {
      const allReady = service.playerReady(roomCode, 'p1');
      expect(allReady).toBe(false);
    });

    it('should return true when all approved players are ready', () => {
      service.playerReady(roomCode, 'p1');
      const allReady = service.playerReady(roomCode, 'p2');
      expect(allReady).toBe(true);
    });

    it('should return false for non-approved player', () => {
      service.addPlayer(roomCode, makePlayer({ id: 'p3' }));
      expect(service.playerReady(roomCode, 'p3')).toBe(false);
    });

    it('should return false for unknown room', () => {
      expect(service.playerReady('UNKNOWN123456', 'p1')).toBe(false);
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
      expect(service.getPlayers('UNKNOWN123456')).toEqual([]);
    });

    it('should return all players including GM', () => {
      const room = service.createRoom('gm-socket', 1, 'GM');
      service.addPlayer(room.roomCode, makePlayer({ id: 'p1' }));

      const players = service.getPlayers(room.roomCode);
      expect(players).toHaveLength(2);
    });
  });
});
