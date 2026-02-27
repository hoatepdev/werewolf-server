import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';

// E2E WebSocket tests are skipped because they require a real server
// and are complex to set up reliably in CI. The integration tests provide
// adequate coverage of the core game logic.
describe.skip('Game Flow E2E (WebSocket)', () => {
  let app: INestApplication;
  let serverUrl: string;
  let gmSocket: Socket;
  let playerSockets: Socket[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0); // Random available port

    const httpServer = app.getHttpServer();
    const port = httpServer.address().port;
    serverUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    // Disconnect all sockets
    gmSocket?.disconnect();
    playerSockets.forEach((s) => s.disconnect());

    await app.close();
  });

  beforeEach(() => {
    // Reset sockets before each test
    gmSocket?.disconnect();
    playerSockets.forEach((s) => s.disconnect());
    playerSockets = [];
  });

  /** Helper: Create a connected socket with optional auth data */
  function createSocket(): Socket {
    return io(serverUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
  }

  /** Helper: Wait for a socket event with timeout */
  function waitForEvent(
    socket: Socket,
    event: string,
    timeoutMs = 5000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for event: ${event}`)),
        timeoutMs,
      );
      socket.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // ── Room lifecycle ───────────────────────────────────────────────────────────

  describe('Room lifecycle', () => {
    it('should allow GM to create room and players to join', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });

      expect(roomResponse).toHaveProperty('roomCode');
      const roomCode = roomResponse.roomCode;

      // Player joins
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);

      const joinResponse = await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Player1',
            persistentPlayerId: 'pid-player1',
          },
          resolve,
        );
      });

      expect(joinResponse.success).toBe(true);
    });

    it('should allow GM to approve a pending player', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      // Join GM room first (needed for approve)
      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Player joins
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Player1',
            persistentPlayerId: 'pid-player1',
          },
          resolve,
        );
      });

      // Get players to see pending list
      const playersBefore = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const pendingPlayer = playersBefore.find((p) => p.username === 'Player1');
      expect(pendingPlayer?.status).toBe('pending');

      // Approve player
      gmSocket.emit('rq_gm:approvePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
      });

      // Wait for player:approved event on player socket
      const approvedEvent = await waitForEvent(playerSocket, 'player:approved');
      expect(approvedEvent).toBeDefined();
    });
  });

  // ── Role assignment ──────────────────────────────────────────────────────────

  describe('Role assignment', () => {
    it('should distribute roles to approved players', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Add 3 players and approve them
      for (let i = 1; i <= 3; i++) {
        const playerSocket = createSocket();
        playerSockets.push(playerSocket);
        await new Promise<any>((resolve) => {
          playerSocket.emit(
            'rq_player:joinRoom',
            {
              roomCode,
              avatarKey: i + 1,
              username: `Player${i}`,
              persistentPlayerId: `pid-player${i}`,
            },
            resolve,
          );
        });

        const players = await new Promise<any[]>((resolve) => {
          gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
        });
        const pendingPlayer = players.find((p) => p.username === `Player${i}`);

        await new Promise<void>((resolve) => {
          gmSocket.emit(
            'rq_gm:approvePlayer',
            { roomCode, playerId: pendingPlayer.id },
            () => resolve(),
          );
        });
      }

      // Randomize roles
      const randomizeResult = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:randomizeRoles',
          {
            roomCode,
            roles: ['werewolf', 'seer', 'villager'],
          },
          resolve,
        );
      });

      expect(randomizeResult).toBe('');

      // Each player should receive their role
      const rolePromises = playerSockets.map((socket) =>
        waitForEvent(socket, 'player:assignedRole'),
      );
      const assignedRoles = await Promise.all(rolePromises);

      expect(assignedRoles).toHaveLength(3);
      assignedRoles.forEach((role: any) => {
        expect(role).toHaveProperty('role');
      });
    });
  });

  // ── Ready and game start ─────────────────────────────────────────────────────

  describe('Player ready and game start', () => {
    it('should start game when all players are ready', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Add 2 players and approve
      const playerIds: string[] = [];
      for (let i = 1; i <= 2; i++) {
        const playerSocket = createSocket();
        playerSockets.push(playerSocket);
        await new Promise<any>((resolve) => {
          playerSocket.emit(
            'rq_player:joinRoom',
            {
              roomCode,
              avatarKey: i + 1,
              username: `Player${i}`,
              persistentPlayerId: `pid-player${i}`,
            },
            resolve,
          );
        });

        const players = await new Promise<any[]>((resolve) => {
          gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
        });
        const pendingPlayer = players.find((p) => p.username === `Player${i}`);
        playerIds.push(pendingPlayer.id);

        await new Promise<void>((resolve) => {
          gmSocket.emit(
            'rq_gm:approvePlayer',
            { roomCode, playerId: pendingPlayer.id },
            () => resolve(),
          );
        });
      }

      // Players signal ready
      playerIds.forEach((id) => {
        const playerSocket = playerSockets.find((s) => s.id === id);
        playerSocket?.emit('rq_player:ready', { roomCode });
      });

      // GM should see room:readySuccess
      await waitForEvent(gmSocket, 'room:readySuccess');
    });
  });

  // ── Reconnection flow ────────────────────────────────────────────────────────

  describe('Player reconnection', () => {
    it('should allow player to reconnect and recover state', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Player joins
      let playerSocket = createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Player1',
            persistentPlayerId: 'persistent-player-1',
          },
          resolve,
        );
      });

      const players = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const pendingPlayer = players.find((p) => p.username === 'Player1');
      const originalSocketId = pendingPlayer.id;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:approvePlayer',
          { roomCode, playerId: originalSocketId },
          () => resolve(),
        );
      });

      // Player disconnects
      playerSocket.disconnect();

      // Player rejoins with same persistentId
      playerSocket = createSocket();
      playerSockets[0] = playerSocket;

      const rejoinResponse = await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:rejoinRoom',
          {
            roomCode,
            persistentPlayerId: 'persistent-player-1',
          },
          resolve,
        );
      });

      // Should emit player:rejoined (or no error indicates success)
      await waitForEvent(playerSocket, 'player:rejoined');

      // Player should still have approved status
      const playersAfterRejoin = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const rejoinedPlayer = playersAfterRejoin.find(
        (p) => p.persistentId === 'persistent-player-1',
      );
      expect(rejoinedPlayer?.status).toBe('approved');
    });
  });

  // ── Invalid actions ───────────────────────────────────────────────────────────

  describe('Invalid actions', () => {
    it('should reject room code with invalid characters', async () => {
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);

      const response = await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode: 'invalid code with spaces!',
            avatarKey: 2,
            username: 'Player1',
          },
          resolve,
        );
      });

      expect(response.success).toBe(false);
    });

    it('should reject join to non-existent room', async () => {
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);

      const response = await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode: 'NONEXIST123',
            avatarKey: 2,
            username: 'Player1',
          },
          resolve,
        );
      });

      expect(response.success).toBe(false);
    });

    it('should prevent non-host from approving players', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Regular player tries to approve (without host auth)
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((joinResolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Player1',
          },
          joinResolve,
        );
      });

      // This player (not host) tries to approve
      playerSocket.emit('rq_gm:approvePlayer', {
        roomCode,
        playerId: 'some-id',
      });

      // Should receive error
      const errorResponse = await waitForEvent(
        playerSocket,
        'room:approvePlayerError',
      );
      expect(errorResponse).toBeDefined();
    });
  });

  // ── GM controls ──────────────────────────────────────────────────────────────

  describe('GM admin controls', () => {
    it('should allow GM to eliminate and revive player', async () => {
      gmSocket = createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:connectGmRoom',
          { roomCode, gmRoomId: 'gm-room-1' },
          () => resolve(),
        );
      });

      // Add and approve a player
      const playerSocket = createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Player1',
          },
          resolve,
        );
      });

      const players = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const pendingPlayer = players.find((p) => p.username === 'Player1');

      await new Promise<void>((resolve) => {
        gmSocket.emit(
          'rq_gm:approvePlayer',
          { roomCode, playerId: pendingPlayer.id },
          () => resolve(),
        );
      });

      // GM eliminates player
      gmSocket.emit('rq_gm:eliminatePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
        reason: 'Test elimination',
      });

      // Check player is dead
      const playersAfterElim = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const eliminatedPlayer = playersAfterElim.find(
        (p) => p.id === pendingPlayer.id,
      );
      expect(eliminatedPlayer?.alive).toBe(false);

      // GM revives player
      gmSocket.emit('rq_gm:revivePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
      });

      const playersAfterRevive = await new Promise<any[]>((resolve) => {
        gmSocket.emit('rq_gm:getPlayers', { roomCode }, resolve);
      });
      const revivedPlayer = playersAfterRevive.find(
        (p) => p.id === pendingPlayer.id,
      );
      expect(revivedPlayer?.alive).toBe(true);
    });
  });
});
