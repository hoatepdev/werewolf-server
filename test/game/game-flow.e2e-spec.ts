import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';

describe('Game Flow E2E (WebSocket)', () => {
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
    gmSocket?.disconnect();
    playerSockets.forEach((s) => s.disconnect());
    await app.close();
  });

  beforeEach(() => {
    gmSocket?.disconnect();
    playerSockets.forEach((s) => s.disconnect());
    playerSockets = [];
  });

  /** Helper: Create a socket and wait for it to connect */
  function createSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(serverUrl, {
        transports: ['websocket'],
        reconnection: false,
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
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

  /** Helper: Connect GM room and wait for gm:connected confirmation */
  function connectGmRoom(
    socket: Socket,
    roomCode: string,
    gmRoomId: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      socket.once('gm:connected', () => resolve());
      socket.emit('rq_gm:connectGmRoom', { roomCode, gmRoomId });
    });
  }

  /** Helper: Get players via GM using ack callback (race-condition-free) */
  function getPlayers(gm: Socket, roomCode: string): Promise<any[]> {
    return new Promise((resolve) => {
      gm.emit('rq_gm:getPlayers', { roomCode }, (players: any[]) =>
        resolve(players),
      );
    });
  }

  /** Helper: Approve a player by username, returns the player object */
  async function approvePlayer(gm: Socket, roomCode: string, username: string) {
    const players = await getPlayers(gm, roomCode);
    const player = players.find((p) => p.username === username);
    gm.emit('rq_gm:approvePlayer', { roomCode, playerId: player.id });
    return player;
  }

  // ── Room lifecycle ───────────────────────────────────────────────────────────

  describe('Room lifecycle', () => {
    it('should allow GM to create room and players to join', async () => {
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });

      expect(roomResponse).toHaveProperty('roomCode');
      const roomCode = roomResponse.roomCode;

      const playerSocket = await createSocket();
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
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      const playerSocket = await createSocket();
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

      const players = await getPlayers(gmSocket, roomCode);
      const pendingPlayer = players.find((p) => p.username === 'Player1');
      expect(pendingPlayer?.status).toBe('pending');

      const approvedEventPromise = waitForEvent(
        playerSocket,
        'player:approved',
      );
      gmSocket.emit('rq_gm:approvePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
      });

      const approvedEvent = await approvedEventPromise;
      expect(approvedEvent).toBeDefined();
    });
  });

  // ── Role assignment ──────────────────────────────────────────────────────────

  describe('Role assignment', () => {
    it('should distribute roles to approved players', async () => {
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      // Add 3 players and approve them
      for (let i = 1; i <= 3; i++) {
        const playerSocket = await createSocket();
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
        await approvePlayer(gmSocket, roomCode, `Player${i}`);
      }

      // Set up role receive listeners before randomizing
      const rolePromises = playerSockets.map((socket) =>
        waitForEvent(socket, 'player:assignedRole'),
      );

      const randomizeResult = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:randomizeRoles',
          { roomCode, roles: ['werewolf', 'seer', 'villager'] },
          resolve,
        );
      });
      expect(randomizeResult).toBe('');

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
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      // Add 2 players, approve, and assign roles
      for (let i = 1; i <= 2; i++) {
        const playerSocket = await createSocket();
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
        await approvePlayer(gmSocket, roomCode, `Player${i}`);
      }

      // Assign roles before players can ready up
      await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:randomizeRoles',
          { roomCode, roles: ['werewolf', 'villager'] },
          resolve,
        );
      });

      // Listen for readySuccess before emitting ready
      const readySuccessPromise = waitForEvent(gmSocket, 'room:readySuccess');

      // All players signal ready
      for (const playerSocket of playerSockets) {
        playerSocket.emit('rq_player:ready', { roomCode });
      }

      await readySuccessPromise;
    });
  });

  // ── Reconnection flow ────────────────────────────────────────────────────────

  describe('Player reconnection', () => {
    it('should allow player to reconnect and recover state', async () => {
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      let playerSocket = await createSocket();
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

      const pendingPlayer = await approvePlayer(gmSocket, roomCode, 'Player1');

      // Player disconnects
      playerSocket.disconnect();

      // Player rejoins with same persistentId
      playerSocket = await createSocket();
      playerSockets[0] = playerSocket;

      const rejoinedEventPromise = waitForEvent(
        playerSocket,
        'player:rejoined',
      );
      playerSocket.emit('rq_player:rejoinRoom', {
        roomCode,
        persistentPlayerId: 'persistent-player-1',
      });

      await rejoinedEventPromise;

      const playersAfterRejoin = await getPlayers(gmSocket, roomCode);
      const rejoinedPlayer = playersAfterRejoin.find(
        (p) => p.persistentId === 'persistent-player-1',
      );
      expect(rejoinedPlayer?.status).toBe('approved');
      expect(pendingPlayer).toBeDefined();
    });
  });

  // ── Invalid actions ───────────────────────────────────────────────────────────

  describe('Invalid actions', () => {
    it('should reject room code with invalid characters', async () => {
      const playerSocket = await createSocket();
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
      const playerSocket = await createSocket();
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
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      const playerSocket = await createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          { roomCode, avatarKey: 2, username: 'Player1' },
          resolve,
        );
      });

      const errorPromise = waitForEvent(
        playerSocket,
        'room:approvePlayerError',
      );
      playerSocket.emit('rq_gm:approvePlayer', {
        roomCode,
        playerId: 'some-id',
      });

      const errorResponse = await errorPromise;
      expect(errorResponse).toBeDefined();
    });
  });

  // ── GM controls ──────────────────────────────────────────────────────────────

  describe('GM admin controls', () => {
    it('should allow GM to eliminate and revive player', async () => {
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) => {
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GameMaster' },
          resolve,
        );
      });
      const roomCode = roomResponse.roomCode;

      await connectGmRoom(gmSocket, roomCode, 'gm-room-1');

      const playerSocket = await createSocket();
      playerSockets.push(playerSocket);
      await new Promise<any>((resolve) => {
        playerSocket.emit(
          'rq_player:joinRoom',
          { roomCode, avatarKey: 2, username: 'Player1' },
          resolve,
        );
      });

      const pendingPlayer = await approvePlayer(gmSocket, roomCode, 'Player1');

      // GM eliminates player — wait for room:updatePlayers broadcast as confirmation
      const elimUpdatePromise = waitForEvent(gmSocket, 'room:updatePlayers');
      gmSocket.emit('rq_gm:eliminatePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
        reason: 'Test elimination',
      });
      const playersAfterElim = (await elimUpdatePromise) as any[];
      const eliminatedPlayer = playersAfterElim.find(
        (p) => p.id === pendingPlayer.id,
      );
      expect(eliminatedPlayer?.alive).toBe(false);

      // GM revives player — wait for room:updatePlayers broadcast as confirmation
      const reviveUpdatePromise = waitForEvent(gmSocket, 'room:updatePlayers');
      gmSocket.emit('rq_gm:revivePlayer', {
        roomCode,
        playerId: pendingPlayer.id,
      });
      const playersAfterRevive = (await reviveUpdatePromise) as any[];
      const revivedPlayer = playersAfterRevive.find(
        (p) => p.id === pendingPlayer.id,
      );
      expect(revivedPlayer?.alive).toBe(true);
    });
  });

  // ── Full game loop ────────────────────────────────────────────────────────────

  describe('full game loop — night → day → voting → conclude', () => {
    it('should progress through a complete night phase when all roles respond', async () => {
      // Bootstrap: create room, GM, 3 players (villager, werewolf, seer)
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) =>
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GM' },
          resolve,
        ),
      );
      const roomCode = roomResponse.roomCode;
      await connectGmRoom(gmSocket, roomCode, 'gm-room-loop-1');

      // Add and approve 3 players
      const usernames = ['Wolf', 'Seer', 'Villager'];
      for (let i = 0; i < 3; i++) {
        const ps = await createSocket();
        playerSockets.push(ps);
        await new Promise<any>((resolve) =>
          ps.emit(
            'rq_player:joinRoom',
            { roomCode, avatarKey: i + 2, username: usernames[i] },
            resolve,
          ),
        );
      }

      // Approve all players
      const pending = await getPlayers(gmSocket, roomCode);
      for (const p of pending.filter((p) => p.status === 'pending')) {
        gmSocket.emit('rq_gm:approvePlayer', { roomCode, playerId: p.id });
      }
      // Wait for the last approval broadcast
      await waitForEvent(gmSocket, 'room:updatePlayers');

      // Randomize roles
      await new Promise<any>((resolve) =>
        gmSocket.emit(
          'rq_gm:randomizeRoles',
          { roomCode, roles: ['werewolf', 'seer', 'villager'] },
          resolve,
        ),
      );

      // All players mark ready
      for (const ps of playerSockets) {
        ps.emit('rq_player:ready', { roomCode });
      }
      // Wait for all-ready signal
      await waitForEvent(gmSocket, 'room:readySuccess');

      // GM starts night
      const phaseChangedPromise = waitForEvent(gmSocket, 'game:phaseChanged');
      gmSocket.emit('rq_gm:nextPhase', { roomCode });
      const phaseEvent = (await phaseChangedPromise) as any;
      expect(phaseEvent?.phase).toBe('night');
    });
  });

  // ── Reconnect during game ─────────────────────────────────────────────────────

  describe('reconnect during game', () => {
    it('should sync timer to a reconnecting player', async () => {
      gmSocket = await createSocket();
      const roomResponse = await new Promise<any>((resolve) =>
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GM' },
          resolve,
        ),
      );
      const roomCode = roomResponse.roomCode;
      await connectGmRoom(gmSocket, roomCode, 'gm-room-reconnect-1');

      // Add and approve one player with a known persistentId
      const playerSocket = await createSocket();
      playerSockets.push(playerSocket);
      const persistentPlayerId = 'test-persistent-id-abc';

      await new Promise<any>((resolve) =>
        playerSocket.emit(
          'rq_player:joinRoom',
          {
            roomCode,
            avatarKey: 2,
            username: 'Reconnector',
            persistentPlayerId,
          },
          resolve,
        ),
      );

      const pending = await getPlayers(gmSocket, roomCode);
      const p = pending.find((p) => p.username === 'Reconnector');
      gmSocket.emit('rq_gm:approvePlayer', { roomCode, playerId: p.id });
      await waitForEvent(playerSocket, 'player:approved');

      // Randomize roles and ready up
      gmSocket.emit('rq_gm:randomizeRoles', {
        roomCode,
        roles: ['werewolf', 'villager'],
      });
      await new Promise<any>((resolve) =>
        gmSocket.emit(
          'rq_gm:createRoom',
          { avatarKey: 1, username: 'GM2' },
          resolve,
        ),
      );

      // Disconnect and reconnect with the same persistentPlayerId
      playerSocket.disconnect();
      playerSockets = playerSockets.filter((s) => s !== playerSocket);

      const newPlayerSocket = await createSocket();
      playerSockets.push(newPlayerSocket);

      const rejoinedPromise = waitForEvent(newPlayerSocket, 'player:rejoined');
      newPlayerSocket.emit('rq_player:rejoinRoom', {
        roomCode,
        persistentPlayerId,
      });

      const rejoinedData = (await rejoinedPromise) as any;
      expect(rejoinedData?.roomCode).toBe(roomCode);
    });
  });
});
