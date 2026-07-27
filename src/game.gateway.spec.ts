/// <reference types="jest" />

import { GameGateway } from '../gateway/game.gateway';
import { RoomService } from '../service/room.service';
import { PhaseManager } from '../service/phase-manager.service';
import { Socket } from 'socket.io';
import { Role } from '../types';

function makeSocket(id: string) {
  return {
    id,
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    data: {},
  } as unknown as Socket;
}

function setServerMock(gateway: GameGateway) {
  const targets = new Map<string, { emit: jest.Mock }>();
  const server = {
    to: jest.fn((target: string) => {
      if (!targets.has(target)) {
        targets.set(target, { emit: jest.fn() });
      }
      return targets.get(target);
    }),
  };

  (gateway as any).server = server;

  return { server, targets };
}

function makeRoomWithSecretRoles() {
  return {
    roomCode: '123456',
    hostId: 'gm-socket',
    gmRoomId: 'gm-room',
    gmPersistentId: 'gm-pid',
    players: [
      {
        id: 'gm-socket',
        persistentId: 'gm-pid',
        username: 'GM',
        avatarKey: 1,
        status: 'gm' as const,
        alive: true,
        role: 'villager' as Role,
      },
      {
        id: 'player-1',
        persistentId: 'pid-1',
        username: 'Player 1',
        avatarKey: 2,
        status: 'approved' as const,
        ready: true,
        alive: true,
        role: 'werewolf' as Role,
      },
      {
        id: 'player-2',
        persistentId: 'pid-2',
        username: 'Player 2',
        avatarKey: 3,
        status: 'approved' as const,
        ready: true,
        alive: true,
        role: 'seer' as Role,
      },
    ],
    phase: 'night' as const,
    round: 1,
    actions: [],
    gameStarted: true,
    lastActivityAt: Date.now(),
  };
}

describe('GameGateway', () => {
  let gateway: GameGateway;
  let roomService: RoomService;
  let phaseManager: PhaseManager;
  let pushNotificationService: { sendToTokens: jest.Mock };

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
      issueReconnectToken: jest.fn(),
      validateReconnectToken: jest.fn(),
      issueGmReconnectToken: jest.fn(),
      validateGmReconnectToken: jest.fn(),
      setOnRoomCleanup: jest.fn(),
      setGmRoomId: jest.fn(),
      getGmRoomId: jest.fn(),
      markGameStarted: jest.fn(),
      isGameStarted: jest.fn(),
      leavePlayer: jest.fn(),
      updatePlayerInfo: jest.fn(),
      resetRoom: jest.fn(),
      getPushTokensForPlayer: jest.fn().mockReturnValue([]),
      getPushTokensForRoomPlayers: jest.fn().mockReturnValue([]),
      removeInvalidPushTokens: jest.fn(),
      registerPushToken: jest.fn(),
      unregisterPushToken: jest.fn(),
      revokeReconnectToken: jest.fn(),
      onModuleDestroy: jest.fn(),
      getGmPushTokens: jest.fn().mockReturnValue([]),
      getPushTokensForPlayers: jest.fn().mockReturnValue([]),
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
      getVotingProgress: jest.fn(),
      getPlayerVotingState: jest.fn(),
      eliminatePlayer: jest.fn(),
      revivePlayer: jest.fn(),
      updatePlayerSocketId: jest.fn(),
      checkWinCondition: jest.fn(),
      cleanupRoom: jest.fn(),
      handlePlayerLeave: jest.fn(),
      updatePlayerInfo: jest.fn(),
      resetRoomState: jest.fn(),
    } as unknown as PhaseManager;

    (roomService.issueGmReconnectToken as jest.Mock).mockReturnValue(
      'gm-token',
    );

    pushNotificationService = {
      sendToTokens: jest.fn().mockResolvedValue({ sent: 0, invalidTokens: [] }),
    };

    gateway = new GameGateway(
      roomService,
      phaseManager,
      pushNotificationService as any,
    );

    // Simulate afterInit and set the server mock
    gateway.afterInit();
    (gateway as any).server = mockServer;
  });

  describe('player payload redaction', () => {
    it('redacts roles and persistent IDs from shared player updates', () => {
      const room = makeRoomWithSecretRoles();
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);

      gateway['emitRoomPlayers']('123456');

      const sharedPayload = targets.get('123456')?.emit.mock.calls[0][1];
      expect(sharedPayload).toEqual([
        expect.not.objectContaining({ role: expect.any(String) }),
        expect.not.objectContaining({ role: expect.any(String) }),
        expect.not.objectContaining({ role: expect.any(String) }),
      ]);
      expect(sharedPayload).toEqual([
        expect.not.objectContaining({ persistentId: expect.any(String) }),
        expect.not.objectContaining({ persistentId: expect.any(String) }),
        expect.not.objectContaining({ persistentId: expect.any(String) }),
      ]);
      expect(
        sharedPayload.find(
          (player: { id: string }) => player.id === 'player-1',
        ),
      ).toEqual(expect.objectContaining({ ready: true }));
    });

    it('still sends full player state to GM targets', () => {
      const room = makeRoomWithSecretRoles();
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);

      gateway['emitRoomPlayers']('123456');

      expect(targets.get('gm-socket')?.emit).toHaveBeenCalledWith(
        'room:updatePlayers',
        room.players,
      );
      expect(targets.get('gm-room')?.emit).toHaveBeenCalledWith(
        'room:updatePlayers',
        room.players,
      );
    });

    it('keeps rq_gm:getPlayers privileged and full-fidelity', () => {
      const socket = makeSocket('gm-socket');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.getPlayers as jest.Mock).mockReturnValue(room.players);

      const result = gateway['handleGmGetPlayers'](socket, {
        roomCode: '123456',
      });

      expect(result).toBe(room.players);
      expect(socket.emit).toHaveBeenCalledWith(
        'room:updatePlayers',
        room.players,
      );
    });

    it('rejects rq_player:getPlayers for non-members', () => {
      const socket = makeSocket('stranger-socket');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);

      gateway['handlePlayerGetPlayers'](socket, { roomCode: '123456' });

      expect(roomService.getPlayers).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('room:updatePlayersError', {
        message: 'Not authorized.',
      });
    });

    it('redacts other players roles for rq_player:getPlayers members', () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.getPlayers as jest.Mock).mockReturnValue(room.players);

      gateway['handlePlayerGetPlayers'](socket, { roomCode: '123456' });

      const payload = (socket.emit as jest.Mock).mock.calls[0][1];
      expect(
        payload.find((player: { id: string }) => player.id === 'player-1'),
      ).toEqual(expect.objectContaining({ role: 'werewolf' }));
      expect(
        payload.find((player: { id: string }) => player.id === 'player-2'),
      ).toEqual(expect.not.objectContaining({ role: expect.any(String) }));
      expect(payload).toEqual(
        expect.arrayContaining([
          expect.not.objectContaining({ persistentId: expect.any(String) }),
        ]),
      );
    });

    it('keeps rejoined player role private and sanitizes embedded players', async () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      const currentPlayer = room.players[1];
      setServerMock(gateway);
      (roomService.validateReconnectToken as jest.Mock).mockReturnValue(true);
      (roomService.rejoinPlayer as jest.Mock).mockReturnValue({
        player: currentPlayer,
        oldSocketId: 'old-socket',
      });
      (roomService.getPlayers as jest.Mock).mockReturnValue(room.players);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (phaseManager.getPhase as jest.Mock).mockReturnValue('night');
      (phaseManager.getTimerInfo as jest.Mock).mockReturnValue(undefined);

      await gateway['handleRejoinRoom'](socket, {
        roomCode: '123456',
        persistentPlayerId: 'pid-1',
        reconnectToken: 'token-1',
      });

      const rejoinedCall = (socket.emit as jest.Mock).mock.calls.find(
        ([event]) => event === 'player:rejoined',
      );
      const payload = rejoinedCall?.[1];
      expect(payload.role).toBe('werewolf');
      expect(
        payload.players.find(
          (player: { id: string }) => player.id === 'player-1',
        ),
      ).toEqual(expect.objectContaining({ role: 'werewolf' }));
      expect(
        payload.players.find(
          (player: { id: string }) => player.id === 'player-2',
        ),
      ).toEqual(expect.not.objectContaining({ role: expect.any(String) }));
      expect(payload.players).toEqual(
        expect.arrayContaining([
          expect.not.objectContaining({ persistentId: expect.any(String) }),
        ]),
      );
    });

    it('does not emit raw room internals in player:approved', () => {
      const socket = makeSocket('gm-socket');
      const room = makeRoomWithSecretRoles();
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.approvePlayer as jest.Mock).mockReturnValue(true);

      gateway['handleApprovePlayer'](socket, {
        roomCode: '123456',
        playerId: 'player-1',
      });

      const payload = targets.get('player-1')?.emit.mock.calls[0][1];
      expect(payload).toEqual(expect.objectContaining({ roomCode: '123456' }));
      expect(payload).toEqual(
        expect.not.objectContaining({ hostId: expect.any(String) }),
      );
      expect(payload).toEqual(
        expect.not.objectContaining({ actions: expect.any(Array) }),
      );
      expect(payload).toEqual(
        expect.not.objectContaining({ gmRoomId: expect.any(String) }),
      );
      expect(payload).toEqual(
        expect.not.objectContaining({ lastActivityAt: expect.any(Number) }),
      );
      expect(
        payload.players.find(
          (player: { id: string }) => player.id === 'player-2',
        ),
      ).toEqual(expect.not.objectContaining({ role: expect.any(String) }));
    });
  });

  describe('rq_gm:connectGmRoom', () => {
    it('allows the current host to connect the GM room and sync state', async () => {
      const socket = makeSocket('gm-socket');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (phaseManager.getPhase as jest.Mock).mockReturnValue('voting');
      (phaseManager.getTimerInfo as jest.Mock).mockReturnValue({
        context: 'voting',
        durationMs: 60000,
        deadline: Date.now() + 30000,
      });

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'gm-room',
      });

      expect(socket.join).toHaveBeenCalledWith('123456');
      expect(socket.join).toHaveBeenCalledWith('gm-room');
      expect(roomService.setGmRoomId).toHaveBeenCalledWith(
        '123456',
        'gm-room',
      );
      expect(phaseManager.setGmRoom).toHaveBeenCalledWith('123456', 'gm-room');
      expect(socket.emit).toHaveBeenCalledWith('gm:connected', {
        roomCode: '123456',
        gmRoomId: 'gm-room',
        message: 'GM connected successfully',
      });
      expect(socket.emit).toHaveBeenCalledWith(
        'room:updatePlayers',
        room.players,
      );
      expect(socket.emit).toHaveBeenCalledWith('game:phaseChanged', {
        phase: 'voting',
      });
      expect(socket.emit).toHaveBeenCalledWith(
        'game:timerSync',
        expect.any(Object),
      );
    });

    it('allows a valid GM token reconnect from a new socket', async () => {
      const socket = makeSocket('new-gm-socket');
      const room = makeRoomWithSecretRoles();
      const reconnectedGm = { ...room.players[0], id: 'new-gm-socket' };
      (roomService.getRoom as jest.Mock)
        .mockReturnValueOnce(room)
        .mockReturnValueOnce({
          ...room,
          hostId: 'new-gm-socket',
          players: [reconnectedGm, ...room.players.slice(1)],
        });
      (roomService.validateGmReconnectToken as jest.Mock).mockReturnValue(true);
      (roomService.reconnectGm as jest.Mock).mockReturnValue(reconnectedGm);
      (phaseManager.getPhase as jest.Mock).mockReturnValue('night');
      (phaseManager.getTimerInfo as jest.Mock).mockReturnValue(undefined);

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'gm-room-new',
        gmPersistentId: 'gm-pid',
        gmReconnectToken: 'gm-token',
      });

      expect(roomService.validateGmReconnectToken).toHaveBeenCalledWith(
        '123456',
        'gm-pid',
        'gm-token',
      );
      expect(roomService.reconnectGm).toHaveBeenCalledWith(
        '123456',
        'new-gm-socket',
        'gm-pid',
      );
      expect(socket.join).toHaveBeenCalledWith('123456');
      expect(socket.join).toHaveBeenCalledWith('gm-room-new');
      expect(roomService.setGmRoomId).toHaveBeenCalledWith(
        '123456',
        'gm-room-new',
      );
      expect(phaseManager.setGmRoom).toHaveBeenCalledWith(
        '123456',
        'gm-room-new',
      );
      expect(socket.emit).toHaveBeenCalledWith('gm:connected', {
        roomCode: '123456',
        gmRoomId: 'gm-room-new',
        message: 'GM connected successfully',
      });
    });

    it('rejects non-host sockets without a valid GM token', async () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.isGmReconnection as jest.Mock).mockReturnValue(true);

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'gm-room',
      });

      expect(socket.join).not.toHaveBeenCalled();
      expect(roomService.reconnectGm).not.toHaveBeenCalled();
      expect(roomService.setGmRoomId).not.toHaveBeenCalled();
      expect(phaseManager.setGmRoom).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('gm:connectRoomError', {
        message: 'Not authorized.',
      });
      expect(socket.emit).not.toHaveBeenCalledWith(
        'gm:connected',
        expect.any(Object),
      );
    });

    it('rejects non-host sockets with an invalid GM token', async () => {
      const socket = makeSocket('new-gm-socket');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.validateGmReconnectToken as jest.Mock).mockReturnValue(
        false,
      );

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'gm-room',
        gmPersistentId: 'gm-pid',
        gmReconnectToken: 'wrong-token',
      });

      expect(roomService.reconnectGm).not.toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
      expect(roomService.setGmRoomId).not.toHaveBeenCalled();
      expect(phaseManager.setGmRoom).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('gm:connectRoomError', {
        message: 'Not authorized.',
      });
    });

    it('ignores invalid payloads', async () => {
      const socket = makeSocket('gm-socket');

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '',
        gmRoomId: 'gm-room',
      });
      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: '',
      });
      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'G'.repeat(51),
      });

      expect(roomService.getRoom).not.toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
      expect(roomService.setGmRoomId).not.toHaveBeenCalled();
      expect(phaseManager.setGmRoom).not.toHaveBeenCalled();
    });

    it('ignores unknown rooms', async () => {
      const socket = makeSocket('gm-socket');
      (roomService.getRoom as jest.Mock).mockReturnValue(undefined);

      await gateway['handleConnectGmRoom'](socket, {
        roomCode: '123456',
        gmRoomId: 'gm-room',
      });

      expect(socket.join).not.toHaveBeenCalled();
      expect(roomService.setGmRoomId).not.toHaveBeenCalled();
      expect(phaseManager.setGmRoom).not.toHaveBeenCalled();
    });
  });

  describe('rq_gm:createRoom', () => {
    it('should validate username, avatarKey, and gmPersistentId', async () => {
      const socket = makeSocket('gm-socket');

      const result1 = await gateway['handleCreateRoom'](socket, {
        username: '',
        avatarKey: 1,
        gmPersistentId: 'gm-pid',
      });
      expect(result1).toEqual({ success: false, message: 'Invalid data.' });

      const result2 = await gateway['handleCreateRoom'](socket, {
        username: 'GM',
        avatarKey: 'invalid' as any,
        gmPersistentId: 'gm-pid',
      });
      expect(result2).toEqual({ success: false, message: 'Invalid data.' });

      const longName = 'a'.repeat(31);
      const result3 = await gateway['handleCreateRoom'](socket, {
        username: longName,
        avatarKey: 1,
        gmPersistentId: 'gm-pid',
      });
      expect(result3).toEqual({ success: false, message: 'Invalid data.' });

      const result4 = await gateway['handleCreateRoom'](socket, {
        username: 'GM',
        avatarKey: 1,
        gmPersistentId: '',
      });
      expect(result4).toEqual({ success: false, message: 'Invalid data.' });
    });

    it('should validate optional roomCode parameter', async () => {
      const socket = makeSocket('gm-socket');

      const invalidRoomCodes = ['', '12345', '1234567', 'ABC123'];
      for (const roomCode of invalidRoomCodes) {
        const result = await gateway['handleCreateRoom'](socket, {
          username: 'GM',
          avatarKey: 1,
          gmPersistentId: 'gm-pid',
          roomCode,
        });
        expect(result).toEqual({
          success: false,
          message: 'Invalid room code.',
        });
      }

      const mockRoom = {
        roomCode: '345678',
        hostId: 'gm-socket',
        gmPersistentId: 'gm-pid',
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
        gmPersistentId: 'gm-pid',
        roomCode: '345678',
      });
      expect((result2 as { roomCode?: string }).roomCode).toBe('345678');
    });

    it('should create room, issue a GM reconnect token, and join socket to room', async () => {
      const socket = makeSocket('gm-socket');
      const mockRoom = {
        roomCode: '456789',
        hostId: 'gm-socket',
        gmPersistentId: 'gm-pid',
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
        gmPersistentId: 'gm-pid',
      });

      expect(roomService.createRoom).toHaveBeenCalledWith(
        'gm-socket',
        1,
        'GameMaster',
        undefined,
        'gm-pid',
      );
      expect(roomService.issueGmReconnectToken).toHaveBeenCalledWith(
        '456789',
        'gm-pid',
      );
      expect(socket.join).toHaveBeenCalledWith('456789');
      expect(result).toEqual(
        expect.objectContaining({
          roomCode: '456789',
          gmReconnectToken: 'gm-token',
        }),
      );
    });
  });

  describe('rq_player:joinRoom', () => {
    it('should validate room code is exactly 6 digits', async () => {
      const socket = makeSocket('player-socket');

      const invalidRoomCodes = ['', '12345', '1234567', 'ABC123'];
      for (const roomCode of invalidRoomCodes) {
        const result = await gateway['handleJoinRoom'](socket, {
          roomCode,
          avatarKey: 1,
          username: 'Player',
        });
        expect(result.success).toBe(false);
      }
    });

    it('should validate username and avatarKey', async () => {
      const socket = makeSocket('player-socket');

      const result1 = await gateway['handleJoinRoom'](socket, {
        roomCode: '234567',
        avatarKey: 1,
        username: '', // empty
      });
      expect(result1.success).toBe(false);

      const result2 = await gateway['handleJoinRoom'](socket, {
        roomCode: '234567',
        avatarKey: 'not-a-number' as any,
        username: 'Player',
      });
      expect(result2.success).toBe(false);
    });

    it('should return failure when roomService.addPlayer fails', async () => {
      const socket = makeSocket('player-socket');
      (roomService.addPlayer as jest.Mock).mockReturnValue(false);

      const result = await gateway['handleJoinRoom'](socket, {
        roomCode: '234567',
        avatarKey: 1,
        username: 'Player',
      });

      expect(result.success).toBe(false);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('should add player, join socket room, and emit update on success', async () => {
      const socket = makeSocket('player-socket');
      const mockRoom = {
        roomCode: '234567',
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
        roomCode: '234567',
        avatarKey: 1,
        username: 'Player',
      });

      expect(result.success).toBe(true);
      expect(socket.join).toHaveBeenCalledWith('234567');
      expect(roomService.addPlayer).toHaveBeenCalledWith(
        '234567',
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
        reconnectToken: 'token-1',
      });
      expect(roomService.rejoinPlayer).not.toHaveBeenCalled();

      // Empty persistentId
      await gateway['handleRejoinRoom'](socket, {
        roomCode: '234567',
        persistentPlayerId: '',
        reconnectToken: 'token-1',
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
      (roomService.rejoinPlayer as jest.Mock).mockReturnValue({
        player: mockPlayer,
        oldSocketId: 'old-socket',
      });
      (roomService.getPlayers as jest.Mock).mockReturnValue([mockPlayer]);
      (roomService.validateReconnectToken as jest.Mock).mockReturnValue(true);
      (phaseManager.getPhase as jest.Mock).mockReturnValue('voting');
      (phaseManager.getTimerInfo as jest.Mock).mockReturnValue({
        context: 'voting',
        durationMs: 60000,
        deadline: Date.now() + 30000,
      });

      await gateway['handleRejoinRoom'](socket, {
        roomCode: '234567',
        persistentPlayerId: 'pid-1',
        reconnectToken: 'token-1',
      });

      expect(roomService.validateReconnectToken).toHaveBeenCalledWith(
        '234567',
        'pid-1',
        'token-1',
      );
      expect(roomService.rejoinPlayer).toHaveBeenCalledWith(
        '234567',
        'new-socket',
        'pid-1',
      );
      expect(phaseManager.updatePlayerSocketId).toHaveBeenCalledWith(
        '234567',
        'pid-1',
        'new-socket',
        'old-socket',
      );
      expect(socket.join).toHaveBeenCalledWith('234567');
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

  describe('room lifecycle events', () => {
    it('should let a player leave and notify the room', async () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.leavePlayer as jest.Mock).mockReturnValue({
        success: true,
        status: 'removed',
        activeGame: false,
        player: room.players[1],
      });

      const result = await gateway['handleLeaveRoom'](socket, {
        roomCode: '123456',
      });

      expect(roomService.leavePlayer).toHaveBeenCalledWith(
        '123456',
        'player-1',
      );
      expect(phaseManager.handlePlayerLeave).not.toHaveBeenCalled();
      expect(socket.leave).toHaveBeenCalledWith('123456');
      expect(result).toEqual(
        expect.objectContaining({ success: true, status: 'removed' }),
      );
    });

    it('should sync active-game player leave into phase manager', async () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.leavePlayer as jest.Mock).mockReturnValue({
        success: true,
        status: 'left_active_game',
        activeGame: true,
        player: room.players[1],
      });

      await gateway['handleLeaveRoom'](socket, { roomCode: '123456' });

      expect(phaseManager.handlePlayerLeave).toHaveBeenCalledWith(
        '123456',
        'player-1',
      );
    });

    it('should update player info and broadcast redacted players', () => {
      const socket = makeSocket('player-1');
      const room = makeRoomWithSecretRoles();
      const updated = { ...room.players[1], username: 'Tên mới', avatarKey: 9 };
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.updatePlayerInfo as jest.Mock).mockReturnValue({
        success: true,
        player: updated,
      });

      const result = gateway['handleUpdateInfo'](socket, {
        roomCode: '123456',
        username: 'Tên mới',
        avatarKey: 9,
      });

      expect(roomService.updatePlayerInfo).toHaveBeenCalledWith(
        '123456',
        'player-1',
        'Tên mới',
        9,
      );
      expect(phaseManager.updatePlayerInfo).toHaveBeenCalledWith(
        '123456',
        'player-1',
        'Tên mới',
        9,
      );
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });

    it('should let the GM reset an ended room', () => {
      const socket = makeSocket('gm-socket');
      const room = { ...makeRoomWithSecretRoles(), phase: 'ended' as const };
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.resetRoom as jest.Mock).mockReturnValue({
        ...room,
        gameStarted: false,
        phase: 'night',
        round: 0,
      });
      (phaseManager.getPhase as jest.Mock).mockReturnValue('ended');

      const result = gateway['handleResetRoom'](socket, {
        roomCode: '123456',
      });

      expect(phaseManager.resetRoomState).toHaveBeenCalledWith('123456');
      expect(roomService.resetRoom).toHaveBeenCalledWith('123456');
      expect(result).toEqual(
        expect.objectContaining({ success: true, phase: 'night' }),
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
        roomCode: '123456',
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
        roomCode: '123456',
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
        roomCode: '123456',
        playerId: 'player-1',
      });

      expect(roomService.approvePlayer).toHaveBeenCalledWith(
        '123456',
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
        roomCode: '123456',
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
        roomCode: '123456',
        playerId: 'player-1',
      });

      expect(roomService.rejectPlayer).toHaveBeenCalledWith(
        '123456',
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
        roomCode: '123456',
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
        roomCode: '123456',
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
        roomCode: '123456',
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
        roomCode: '123456',
        roles: ['invalid-role' as Role],
      });

      expect(result).toBe('Invalid roles provided');
    });

    it('should accept cupid in randomized roles', () => {
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
      (roomService.randomizeRoles as jest.Mock).mockReturnValue(true);

      const result = gateway['handleRandomizeRoles'](socket, {
        roomCode: '123456',
        roles: ['werewolf', 'cupid'],
      });

      expect(roomService.randomizeRoles).toHaveBeenCalledWith('123456', [
        'werewolf',
        'cupid',
      ]);
      expect(result).toBe('');
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
        roomCode: '123456',
        roles: ['werewolf', 'seer'],
      });

      expect(roomService.randomizeRoles).toHaveBeenCalledWith('123456', [
        'werewolf',
        'seer',
      ]);
      expect(result).toBe('');
    });
  });

  describe('rq_player:ready', () => {
    it('should broadcast player updates without starting game until all players are ready', () => {
      const socket = makeSocket('player-1');
      const room = {
        ...makeRoomWithSecretRoles(),
        gameStarted: false,
        players: makeRoomWithSecretRoles().players.map((player) =>
          player.id === 'player-2' ? { ...player, ready: false } : player,
        ),
      };
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.playerReady as jest.Mock).mockReturnValue(false);

      gateway['handlePlayerReady'](socket, { roomCode: '123456' });

      expect(roomService.playerReady).toHaveBeenCalledWith(
        '123456',
        'player-1',
      );
      expect(targets.get('123456')?.emit).toHaveBeenCalledWith(
        'room:updatePlayers',
        expect.any(Array),
      );
      expect(socket.emit).toHaveBeenCalledWith('player:readySuccess', {
        roomCode: '123456',
      });
      expect(roomService.markGameStarted).not.toHaveBeenCalled();
      expect(phaseManager.initGameState).not.toHaveBeenCalled();
      expect(targets.get('123456')?.emit).not.toHaveBeenCalledWith(
        'room:readySuccess',
      );
    });

    it('should mark game started, initialize phase state, then emit ready success when all players are ready', () => {
      const socket = makeSocket('player-1');
      const room = { ...makeRoomWithSecretRoles(), gameStarted: false };
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.playerReady as jest.Mock).mockReturnValue(true);
      (roomService.markGameStarted as jest.Mock).mockReturnValue(true);
      (roomService.getGmRoomId as jest.Mock).mockReturnValue('gm-room');

      gateway['handlePlayerReady'](socket, { roomCode: '123456' });

      expect(roomService.markGameStarted).toHaveBeenCalledWith('123456');
      expect(phaseManager.initGameState).toHaveBeenCalledWith(
        '123456',
        room.players.filter((player) => player.status === 'approved'),
        'gm-room',
      );
      expect(targets.get('123456')?.emit).toHaveBeenCalledWith(
        'room:readySuccess',
      );
      const readySuccessCallOrder = targets
        .get('123456')
        ?.emit.mock.calls.findIndex(([event]) => event === 'room:readySuccess');
      expect(readySuccessCallOrder).toBeGreaterThan(-1);
      expect(
        (roomService.markGameStarted as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(
        targets.get('123456')!.emit.mock.invocationCallOrder[
          readySuccessCallOrder!
        ],
      );
      expect(
        (phaseManager.initGameState as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(
        targets.get('123456')!.emit.mock.invocationCallOrder[
          readySuccessCallOrder!
        ],
      );
    });

    it('should not emit room ready success when marking game started fails', () => {
      const socket = makeSocket('player-1');
      const room = { ...makeRoomWithSecretRoles(), gameStarted: false };
      const { targets } = setServerMock(gateway);
      (roomService.getRoom as jest.Mock).mockReturnValue(room);
      (roomService.playerReady as jest.Mock).mockReturnValue(true);
      (roomService.markGameStarted as jest.Mock).mockReturnValue(false);

      gateway['handlePlayerReady'](socket, { roomCode: '123456' });

      expect(roomService.markGameStarted).toHaveBeenCalledWith('123456');
      expect(phaseManager.initGameState).not.toHaveBeenCalled();
      expect(targets.get('123456')?.emit).not.toHaveBeenCalledWith(
        'room:readySuccess',
      );
    });
  });

  describe('rq_gm:nextPhase', () => {
    beforeEach(() => {
      (roomService.getRoom as jest.Mock).mockReturnValue({
        hostId: 'gm-socket',
        players: [],
        phase: 'night',
        round: 0,
        actions: [],
        lastActivityAt: Date.now(),
      });
    });

    it('should validate room code', () => {
      const socket = makeSocket('gm-socket');

      gateway['handleNextPhase'](socket, { roomCode: '' });

      // Should not call canTransition with invalid code
      expect(phaseManager.canTransition).not.toHaveBeenCalled();
    });

    it('should reject non-host sockets', () => {
      const socket = makeSocket('player-socket');

      gateway['handleNextPhase'](socket, { roomCode: '123456' });

      expect(phaseManager.getPhase).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('room:phaseError', {
        message: 'Not authorized.',
      });
    });

    it('should transition from day to voting when allowed', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('day');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(true);

      gateway['handleNextPhase'](socket, { roomCode: '123456' });

      expect(phaseManager.canTransition).toHaveBeenCalledWith(
        '123456',
        'voting',
      );
      expect(phaseManager.startVotingPhase).toHaveBeenCalledWith('123456');
    });

    it('should transition from conclude to night', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('conclude');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(true);
      (phaseManager.startNightPhase as jest.Mock).mockResolvedValue(undefined);

      gateway['handleNextPhase'](socket, { roomCode: '123456' });

      expect(phaseManager.canTransition).toHaveBeenCalledWith(
        '123456',
        'night',
      );
      expect(phaseManager.startNightPhase).toHaveBeenCalledWith('123456');
    });

    it('should emit error when transition not allowed', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('day');
      (phaseManager.canTransition as jest.Mock).mockReturnValue(false);

      gateway['handleNextPhase'](socket, { roomCode: '123456' });

      expect(socket.emit).toHaveBeenCalledWith(
        'room:phaseError',
        expect.any(Object),
      );
    });

    it('should emit error for ended game', () => {
      const socket = makeSocket('gm-socket');
      (phaseManager.getPhase as jest.Mock).mockReturnValue('ended');

      gateway['handleNextPhase'](socket, { roomCode: '123456' });

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
      gateway['handleCupidActionDone'](socket, {
        roomCode: '',
        targetIds: ['p1', 'p2'],
      });

      expect(phaseManager.handleRoleResponse).not.toHaveBeenCalled();
    });

    it('should delegate werewolf action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleWerewolfActionDone'](socket, {
        roomCode: '123456',
        targetId: 'p1',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        expect.objectContaining({ targetId: 'p1', vote: 'werewolf' }),
      );
    });

    it('should delegate seer action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleSeerActionDone'](socket, {
        roomCode: '123456',
        targetId: 'p2',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        expect.objectContaining({ targetId: 'p2', vote: 'seer' }),
      );
    });

    it('should delegate witch action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleWitchActionDone'](socket, {
        roomCode: '123456',
        heal: true,
        poisonTargetId: 'p3',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
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
        roomCode: '123456',
        targetId: 'p4',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        expect.objectContaining({ targetId: 'p4', vote: 'bodyguard' }),
      );
    });

    it('should delegate cupid action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleCupidActionDone'](socket, {
        roomCode: '123456',
        targetIds: ['p1', 'p2'],
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        expect.objectContaining({ targetIds: ['p1', 'p2'], vote: 'cupid' }),
      );
    });

    it('should reject malformed cupid action payload', () => {
      const socket = makeSocket('player-socket');

      gateway['handleCupidActionDone'](socket, {
        roomCode: '123456',
        targetIds: 'p1' as any,
      });

      expect(phaseManager.handleRoleResponse).not.toHaveBeenCalled();
    });

    it('should delegate hunter action to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleHunterActionDone'](socket, {
        roomCode: '123456',
        targetId: 'p5',
      });

      expect(phaseManager.handleRoleResponse).toHaveBeenCalledWith(
        '123456',
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
        roomCode: '123456',
        targetId: '',
      });
      expect(phaseManager.handleVotingResponse).not.toHaveBeenCalled();
    });

    it('should delegate voting response to phaseManager', () => {
      const socket = makeSocket('player-socket');
      (roomService.getRoom as jest.Mock).mockReturnValue({});

      gateway['handleVotingDone'](socket, {
        roomCode: '123456',
        targetId: 'p2',
      });

      expect(phaseManager.handleVotingResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        { choice: undefined, targetId: 'p2' },
      );
    });

    it('should delegate explicit abstain to phaseManager', () => {
      const socket = makeSocket('player-socket');

      gateway['handleVotingDone'](socket, {
        roomCode: '123456',
        choice: 'abstain',
        targetId: null,
      });

      expect(phaseManager.handleVotingResponse).toHaveBeenCalledWith(
        '123456',
        'player-socket',
        { choice: 'abstain', targetId: null },
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
        roomCode: '123456',
        targetId: 'p2',
        winCondition: 'werewolves',
      });

      expect(phaseManager.handleHunterDeathShoot).toHaveBeenCalledWith(
        '123456',
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
      (roomService.findRoomBySocketId as jest.Mock).mockReturnValue('123456');
      (roomService.getRoom as jest.Mock).mockReturnValue(mockRoom);
      gateway['server'] = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as any;

      gateway['handleDisconnect'](socket);

      expect(roomService.setGmDisconnected).toHaveBeenCalledWith(
        '123456',
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
      (roomService.findRoomBySocketId as jest.Mock).mockReturnValue('123456');
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
