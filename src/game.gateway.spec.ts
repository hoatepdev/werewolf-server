import { GameGateway } from '../gateway/game.gateway';
import { RoomService } from '../service/room.service';
import { PhaseManager } from '../service/phase-manager.service';
import { Socket } from 'socket.io';
import { Role } from '../types';

function makeSocket(id: string) {
  return {
    id,
    join: jest.fn(),
    emit: jest.fn(),
    data: {},
  } as unknown as Socket;
}

describe('GameGateway', () => {
  let gateway: GameGateway;
  let roomService: RoomService;
  let phaseManager: PhaseManager;

  beforeEach(() => {
    // Mock server for emit calls
    const mockServer = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    };

    roomService = {
      createRoom: jest.fn(),
      getRoom: jest.fn(),
      addPlayer: jest.fn(),
      approvePlayer: jest.fn(),
      rejectPlayer: jest.fn(),
      getPlayers: jest.fn(),
      eliminatePlayer: jest.fn(),
      revivePlayer: jest.fn(),
      randomizeRoles: jest.fn(),
      playerReady: jest.fn(),
      findRoomBySocketId: jest.fn(),
      setGmDisconnected: jest.fn(),
      isGmReconnection: jest.fn(),
      reconnectGm: jest.fn(),
      rejoinPlayer: jest.fn(),
      setOnRoomCleanup: jest.fn(),
      onModuleDestroy: jest.fn(),
    } as unknown as RoomService;

    phaseManager = {
      setServer: jest.fn(),
      setGmRoom: jest.fn(),
      initGameState: jest.fn(),
      startNightPhase: jest.fn(),
      startDayPhase: jest.fn(),
      startVotingPhase: jest.fn(),
      handleRoleResponse: jest.fn(),
      handleVotingResponse: jest.fn(),
      handleHunterDeathShoot: jest.fn(),
      getPhase: jest.fn(),
      canTransition: jest.fn(),
      getTimerInfo: jest.fn(),
      eliminatePlayer: jest.fn(),
      revivePlayer: jest.fn(),
      updatePlayerSocketId: jest.fn(),
      checkWinCondition: jest.fn(),
      cleanupRoom: jest.fn(),
    } as unknown as PhaseManager;

    gateway = new GameGateway(roomService, phaseManager);

    // Simulate afterInit and set the server mock
    gateway.afterInit();
    (gateway as any).server = mockServer;
  });

  describe('rq_gm:createRoom', () => {
    it('should validate username and avatarKey', async () => {
      const socket = makeSocket('gm-socket');

      // Missing username
      const result1 = await gateway['handleCreateRoom'](socket, {
        username: '',
        avatarKey: 1,
      });
      expect(result1).toEqual({ success: false, message: 'Invalid data.' });

      // Invalid avatarKey type
      const result2 = await gateway['handleCreateRoom'](socket, {
        username: 'GM',
        avatarKey: 'invalid' as any,
      });
      expect(result2).toEqual({ success: false, message: 'Invalid data.' });

      // Username too long
      const longName = 'a'.repeat(31);
      const result3 = await gateway['handleCreateRoom'](socket, {
        username: longName,
        avatarKey: 1,
      });
      expect(result3).toEqual({ success: false, message: 'Invalid data.' });
    });

    it('should validate optional roomCode parameter', async () => {
      const socket = makeSocket('gm-socket');

      // Room code over 20 chars should fail
      const result1 = await gateway['handleCreateRoom'](socket, {
        username: 'GM',
        avatarKey: 1,
        roomCode: 'A'.repeat(21),
      });
      expect(result1).toEqual({
        success: false,
        message: 'Invalid room code.',
      });

      // Valid custom room code
      const mockRoom = {
        roomCode: 'CUSTOM123456',
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.createRoom as jest.Mock).mockReturnValue(mockRoom);

      const result2 = await gateway['handleCreateRoom'](socket, {
        username: 'GM',
        avatarKey: 1,
        roomCode: 'CUSTOM123456',
      });
      expect((result2 as { roomCode?: string }).roomCode).toBe('CUSTOM123456');
    });

    it('should create room and join socket to room', async () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        roomCode: 'ABCD12345678',
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.createRoom as jest.Mock).mockReturnValue(mockRoom);

      const result = await gateway['handleCreateRoom'](socket, {
        username: 'GameMaster',
        avatarKey: 1,
      });

      expect(roomService.createRoom).toHaveBeenCalledWith(
        'gm-socket',
        1,
        'GameMaster',
        undefined,
      );
      expect(socket.join).toHaveBeenCalledWith('ABCD12345678');
      expect(result).toHaveProperty('roomCode');
    });
  });

  describe('rq_player:joinRoom', () => {
    it('should validate room code is non-empty and within length limit', async () => {
      const socket = makeSocket('player-socket');

      // Empty room code should fail
      const result1 = await gateway['handleJoinRoom'](socket, {
        roomCode: '',
        avatarKey: 1,
        username: 'Player',
      });
      expect(result1.success).toBe(false);

      // Room code over 20 chars should fail
      const result2 = await gateway['handleJoinRoom'](socket, {
        roomCode: 'A'.repeat(21),
        avatarKey: 1,
        username: 'Player',
      });
      expect(result2.success).toBe(false);
    });

    it('should validate username and avatarKey', async () => {
      const socket = makeSocket('player-socket');

      const result1 = await gateway['handleJoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        avatarKey: 1,
        username: '', // empty
      });
      expect(result1.success).toBe(false);

      const result2 = await gateway['handleJoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        avatarKey: 'not-a-number' as any,
        username: 'Player',
      });
      expect(result2.success).toBe(false);
    });

    it('should return failure when roomService.addPlayer fails', async () => {
      const socket = makeSocket('player-socket');
      (roomService.addPlayer as jest.Mock).mockReturnValue(false);

      const result = await gateway['handleJoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        avatarKey: 1,
        username: 'Player',
      });

      expect(result.success).toBe(false);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('should add player, join socket room, and emit update on success', async () => {
      const socket = makeSocket('player-socket');
      const mockRoom = {
        roomCode: 'VALIDROOM1234',
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      (roomService.addPlayer as jest.Mock).mockReturnValue(true);

      const result = await gateway['handleJoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        avatarKey: 1,
        username: 'Player',
      });

      expect(result.success).toBe(true);
      expect(socket.join).toHaveBeenCalledWith('VALIDROOM1234');
      expect(roomService.addPlayer).toHaveBeenCalledWith(
        'VALIDROOM1234',
        expect.objectContaining({
          id: 'player-socket',
          username: 'Player',
          avatarKey: 1,
        }),
      );
    });
  });

  describe('rq_player:rejoinRoom', () => {
    it('should validate inputs', async () => {
      const socket = makeSocket('new-socket');

      // Empty room code
      await gateway['handleRejoinRoom'](socket, {
        roomCode: '',
        persistentPlayerId: 'pid-1',
      });
      expect(roomService.rejoinPlayer).not.toHaveBeenCalled();

      // Empty persistentId
      await gateway['handleRejoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        persistentPlayerId: '',
      });
      expect(roomService.rejoinPlayer).not.toHaveBeenCalled();
    });

    it('should rejoin player and sync timer if active', async () => {
      const socket = makeSocket('new-socket');
      const mockPlayer = {
        id: 'new-socket',
        username: 'Player',
        avatarKey: 1,
        status: 'approved' as const,
        alive: true,
        persistentId: 'pid-1',
      };
      (roomService.rejoinPlayer as jest.Mock).mockReturnValue(mockPlayer);
      (phaseManager.getTimerInfo as jest.Mock).mockReturnValue({
        context: 'voting',
        durationMs: 60000,
        deadline: Date.now() + 30000,
      });

      await gateway['handleRejoinRoom'](socket, {
        roomCode: 'VALIDROOM1234',
        persistentPlayerId: 'pid-1',
      });

      expect(roomService.rejoinPlayer).toHaveBeenCalledWith(
        'VALIDROOM1234',
        'new-socket',
        'pid-1',
      );
      expect(phaseManager.updatePlayerSocketId).toHaveBeenCalledWith(
        'VALIDROOM1234',
        'pid-1',
        'new-socket',
      );
      expect(socket.join).toHaveBeenCalledWith('VALIDROOM1234');
      expect(socket.emit).toHaveBeenCalledWith(
        'player:rejoined',
        expect.any(Object),
      );
      expect(socket.emit).toHaveBeenCalledWith(
        'game:timerSync',
        expect.any(Object),
      );
    });
  });

  describe('rq_gm:approvePlayer', () => {
    it('should authorize that only host can approve', () => {
      const socket = makeSocket('non-host-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      gateway['handleApprovePlayer'](socket, {
        roomCode: 'ROOM123',
        playerId: 'player-1',
      });

      expect(roomService.approvePlayer).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('room:approvePlayerError', {
        message: 'Not authorized.',
      });
    });

    it('should validate inputs', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      // Empty room code
      gateway['handleApprovePlayer'](socket, { roomCode: '', playerId: 'p1' });
      expect(roomService.approvePlayer).not.toHaveBeenCalled();

      // Empty playerId
      gateway['handleApprovePlayer'](socket, {
        roomCode: 'ROOM123',
        playerId: '',
      });
      expect(roomService.approvePlayer).not.toHaveBeenCalled();
    });

    it('should approve player and broadcast update', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      (roomService.approvePlayer as jest.Mock).mockReturnValue(true);

      gateway['handleApprovePlayer'](socket, {
        roomCode: 'ROOM123',
        playerId: 'player-1',
      });

      expect(roomService.approvePlayer).toHaveBeenCalledWith(
        'ROOM123',
        'player-1',
      );
    });
  });

  describe('rq_gm:rejectPlayer', () => {
    it('should authorize that only host can reject', () => {
      const socket = makeSocket('non-host-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      gateway['handleRejectPlayer'](socket, {
        roomCode: 'ROOM123',
        playerId: 'player-1',
      });

      expect(socket.emit).toHaveBeenCalledWith('room:rejectPlayerError', {
        message: 'Not authorized.',
      });
    });

    it('should reject player and broadcast update', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      (roomService.rejectPlayer as jest.Mock).mockReturnValue(true);

      gateway['handleRejectPlayer'](socket, {
        roomCode: 'ROOM123',
        playerId: 'player-1',
      });

      expect(roomService.rejectPlayer).toHaveBeenCalledWith(
        'ROOM123',
        'player-1',
      );
    });
  });

  describe('rq_gm:randomizeRoles', () => {
    it('should validate inputs', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      // Empty room code should fail
      const result1 = gateway['handleRandomizeRoles'](socket, {
        roomCode: '',
        roles: [],
      });
      expect(result1).toBe('Invalid data.');

      // Invalid roles array (not an array)
      const result2 = gateway['handleRandomizeRoles'](socket, {
        roomCode: 'ROOM123',
        roles: 'not-array' as any,
      });
      expect(result2).toBe('Invalid data.');
    });

    it('should authorize that only host can randomize', () => {
      const socket = makeSocket('non-host-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      const result = gateway['handleRandomizeRoles'](socket, {
        roomCode: 'ROOM123',
        roles: ['werewolf'],
      });

      expect(result).toBe('Not authorized.');
      expect(socket.emit).toHaveBeenCalledWith('room:randomizeRolesError', {
        message: 'Not authorized.',
      });
    });

    it('should validate role list includes at least one werewolf', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      const result = gateway['handleRandomizeRoles'](socket, {
        roomCode: 'ROOM123',
        roles: ['villager', 'seer'],
      });

      expect(result).toBe('Role list must include at least one werewolf');
    });

    it('should validate all provided roles are valid', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);

      const result = gateway['handleRandomizeRoles'](socket, {
        roomCode: 'ROOM123',
        roles: ['invalid-role' as Role],
      });

      expect(result).toBe('Invalid roles provided');
    });

    it('should randomize roles and emit to each approved player', () => {
      const socket = makeSocket('gm-socket');
      const mockPlayers = [
        {
          id: 'p1',
          username: 'P1',
          avatarKey: 1,
          status: 'approved' as const,
          alive: true,
          role: 'werewolf',
        },
        {
          id: 'p2',
          username: 'P2',
          avatarKey: 2,
          status: 'approved' as const,
          alive: true,
          role: 'seer',
        },
      ];
      const mockRoom = {
        hostId: 'gm-socket',
        players: mockPlayers,
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      (roomService.randomizeRoles as jest.Mock).mockReturnValue(true);
      gateway['server'] = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as any;

      const result = gateway['handleRandomizeRoles'](socket, {
        roomCode: 'ROOM123',
        roles: ['werewolf', 'seer'],
      });

      expect(roomService.randomizeRoles).toHaveBeenCalledWith('ROOM123', [
        'werewolf',
        'seer',
      ]);
      expect(result).toBe('');
    });
  });

  describe('rq_gm:nextPhase', () => {
    it('should validate room code', () => {
      const socket = makeSocket('gm-socket');

      gateway['handleNextPhase'](socket, { roomCode: 'invalid!' });

      // Should not call canTransition with invalid code
      expect(phaseManager.canTransition).not.toHaveBeenCalled();
    });

    it('should transition from day to voting when allowed', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('day');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(true);

      gateway['handleNextPhase'](socket, { roomCode: 'ROOM123' });

      expect(phaseManager.canTransition).toHaveBeenCalledWith(
        'ROOM123',
        'voting',
      );
      expect(phaseManager.startVotingPhase).toHaveBeenCalledWith('ROOM123');
    });

    it('should transition from conclude to night', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('conclude');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(true);
      (phaseManager.startNightPhase as jest.Mock).mockResolvedValue(undefined);

      gateway['handleNextPhase'](socket, { roomCode: 'ROOM123' });

      expect(phaseManager.canTransition).toHaveBeenCalledWith(
        'ROOM123',
        'night',
      );
      expect(phaseManager.startNightPhase).toHaveBeenCalledWith('ROOM123');
    });

    it('should emit error when transition not allowed', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('day');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(false);

      gateway['handleNextPhase'](socket, { roomCode: 'ROOM123' });

      expect(socket.emit).toHaveBeenCalledWith(
        'room:phaseError',
        expect.any(Object),
      );
    });

    it('should emit error for ended game', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('ended');

      gateway['handleNextPhase'](socket, { roomCode: 'ROOM123' });

      expect(socket.emit).toHaveBeenCalledWith('room:phaseError', {
        message: 'Trò chơi đã kết thúc.',
      });
    });
  });

  describe('night action handlers', () => {
    it('should validate room code for all night actions', () => {
      const socket = makeSocket('player-socket');

      // Empty room code should fail validation
      gateway['handleWerewolfActionDone'](socket, {
        roomCode: '',
        targetId: 'p1',
      });
      gateway['handleSeerActionDone'](socket, { roomCode: '', targetId: 'p1' });
      gateway['handleWitchActionDone'](socket, { roomCode: '', heal: false });
      gateway['handleBodyguardActionDone'](socket, {
        roomCode: '',
        targetId: 'p1',
      });

      expect(phaseManager.handleRoleResponse).not.toHaveBeenCalled();
    });

    it('should delegate werewolf action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleWerewolfActionDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p1',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        expect.objectContaining({ targetId: 'p1', vote: 'werewolf' }),
      );
    });

    it('should delegate seer action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleSeerActionDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p2',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        expect.objectContaining({ targetId: 'p2', vote: 'seer' }),
      );
    });

    it('should delegate witch action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleWitchActionDone'](socket, {
        roomCode: 'ROOM123',
        heal: true,
        poisonTargetId: 'p3',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        expect.objectContaining({
          heal: true,
          poisonTargetId: 'p3',
          vote: 'witch',
        }),
      );
    });

    it('should delegate bodyguard action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleBodyguardActionDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p4',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        expect.objectContaining({ targetId: 'p4', vote: 'bodyguard' }),
      );
    });

    it('should delegate hunter action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleHunterActionDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p5',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        expect.objectContaining({ targetId: 'p5', vote: 'hunter' }),
      );
    });
  });

  describe('voting:done', () => {
    it('should validate room code and targetId', () => {
      const socket = makeSocket('player-socket');

      // Empty targetId should fail
      (roomService.getRoom as jest.Mock).mockReturnValue({});
      gateway['handleVotingDone'](socket, {
        roomCode: 'ROOM123',
        targetId: '',
      });
      expect(phaseManager.handleVotingResponse).not.toHaveBeenCalled();
    });

    it('should delegate voting response to phaseManager', () => {
      const socket = makeSocket('player-socket');
      (roomService.getRoom as jest.Mock).mockReturnValue({});

      gateway['handleVotingDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p2',
      });

      expect(phaseManager.handleVotingResponse).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        'p2',
      );
    });
  });

  describe('game:hunterShoot:done', () => {
    it('should validate room code', () => {
      const socket = makeSocket('player-socket');

      // Empty room code
      gateway['handleHunterShootDone'](socket, {
        roomCode: '',
        targetId: 'p1',
      });
      expect(phaseManager.handleHunterDeathShoot).not.toHaveBeenCalled();
    });

    it('should delegate hunter shoot to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleHunterShootDone'](socket, {
        roomCode: 'ROOM123',
        targetId: 'p2',
        winCondition: 'werewolves',
      });

      expect(phaseManager.handleHunterDeathShoot).toHaveBeenCalledWith(
        'ROOM123',
        'player-socket',
        'p2',
      );
    });
  });

  describe('handleDisconnect', () => {
    it('should track GM disconnection', () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [
          {
            id: 'gm-socket',
            username: 'GM',
            avatarKey: 1,
            status: 'gm' as const,
          },
        ],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.findRoomBySocketId as jest.Mock).mockReturnValue('ROOM123');
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      gateway['server'] = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as any;

      gateway['handleDisconnect'](socket);

      expect(roomService.setGmDisconnected).toHaveBeenCalledWith(
        'ROOM123',
        'gm-socket',
      );
    });

    it('should emit player disconnection for non-GM players', () => {
      const socket = makeSocket('player-socket');
      const mockRoom = {
        hostId: 'gm-socket',
        players: [
          {
            id: 'gm-socket',
            username: 'GM',
            avatarKey: 1,
            status: 'gm' as const,
          },
          {
            id: 'player-socket',
            username: 'Player',
            avatarKey: 2,
            status: 'approved' as const,
          },
        ],
        phase: 'night' as const,
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      };
      (roomService.findRoomBySocketId as jest.Mock).mockReturnValue('ROOM123');
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      gateway['server'] = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as any;

      gateway['handleDisconnect'](socket);

      expect(roomService.setGmDisconnected).not.toHaveBeenCalled();
    });

    it('should do nothing when socket not found in any room', () => {
      const socket = makeSocket('unknown-socket');
      (roomService.findRoomBySocketId as jest.Mock).mockReturnValue(undefined);

      gateway['handleDisconnect'](socket);

      expect(roomService.getRoom).not.toHaveBeenCalled();
    });
  });
});
