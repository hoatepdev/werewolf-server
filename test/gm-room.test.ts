import { Test, TestingModule } from '@nestjs/testing';
import { RoomService } from '../service/room.service';
import { PhaseManager } from '../service/phase-manager.service';
import { GameGateway } from '../gateway/game.gateway';
import { Server } from 'socket.io';
import { Player, Role } from '../types';

describe('GM Room Functionality', () => {
  let roomService: RoomService;
  let phaseManager: PhaseManager;
  let gameGateway: GameGateway;
  let mockServer: Partial<Server>;

  const mockSocket = {
    id: 'test-socket-id',
    join: jest.fn(),
    emit: jest.fn(),
  };

  const mockPlayer: Player = {
    id: 'player-1',
    username: 'TestPlayer',
    avatarKey: 1,
    status: 'approved',
    alive: true,
    role: 'villager',
  };

  const mockGmPlayer: Player = {
    id: 'gm-socket-id',
    username: 'GameMaster',
    avatarKey: 0,
    status: 'gm',
    alive: true,
  };

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RoomService, PhaseManager, GameGateway],
    }).compile();

    roomService = module.get<RoomService>(RoomService);
    phaseManager = module.get<PhaseManager>(PhaseManager);
    gameGateway = module.get<GameGateway>(GameGateway);

    gameGateway.server = mockServer as Server;
    phaseManager.setServer(mockServer as Server);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('RoomService - GM Features', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = roomService.createRoom('gm-socket-id', 0, 'GameMaster');
      roomCode = room.roomCode;
    });

    describe('eliminatePlayer', () => {
      it('should eliminate an approved player successfully', () => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);

        const result = roomService.eliminatePlayer(
          roomCode,
          mockPlayer.id,
          'Test elimination',
        );

        expect(result).toBe(true);

        const room = roomService.getRoom(roomCode);
        const player = room?.players.find((p) => p.id === mockPlayer.id);
        expect(player?.alive).toBe(false);
        expect(room?.actions).toHaveLength(1);
        expect(room?.actions[0]).toMatchObject({
          type: 'gm_elimination',
          playerId: mockPlayer.id,
          reason: 'Test elimination',
        });
      });

      it('should not eliminate a pending player', () => {
        roomService.addPlayer(roomCode, mockPlayer);

        const result = roomService.eliminatePlayer(roomCode, mockPlayer.id);

        expect(result).toBe(false);

        const room = roomService.getRoom(roomCode);
        const player = room?.players.find((p) => p.id === mockPlayer.id);
        expect(player?.alive).toBeUndefined();
      });

      it('should not eliminate a non-existent player', () => {
        const result = roomService.eliminatePlayer(roomCode, 'non-existent-id');

        expect(result).toBe(false);
      });

      it('should not eliminate a player in non-existent room', () => {
        const result = roomService.eliminatePlayer(
          'non-existent-room',
          mockPlayer.id,
        );

        expect(result).toBe(false);
      });
    });

    describe('revivePlayer', () => {
      beforeEach(() => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);
        roomService.eliminatePlayer(roomCode, mockPlayer.id);
      });

      it('should revive a dead player successfully', () => {
        const result = roomService.revivePlayer(roomCode, mockPlayer.id);

        expect(result).toBe(true);

        const room = roomService.getRoom(roomCode);
        const player = room?.players.find((p) => p.id === mockPlayer.id);
        expect(player?.alive).toBe(true);
        expect(room?.actions).toHaveLength(2);
        expect(room?.actions[1]).toMatchObject({
          type: 'gm_revival',
          playerId: mockPlayer.id,
        });
      });

      it('should not revive a non-existent player', () => {
        const result = roomService.revivePlayer(roomCode, 'non-existent-id');

        expect(result).toBe(false);
      });

      it('should not revive a player in non-existent room', () => {
        const result = roomService.revivePlayer(
          'non-existent-room',
          mockPlayer.id,
        );

        expect(result).toBe(false);
      });
    });

    describe('getPlayers', () => {
      it('should return all players including GM', () => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);

        const players = roomService.getPlayers(roomCode);

        expect(players).toHaveLength(2);
        expect(players.find((p) => p.status === 'gm')).toBeDefined();
        expect(players.find((p) => p.id === mockPlayer.id)).toBeDefined();
      });

      it('should return empty array for non-existent room', () => {
        const players = roomService.getPlayers('non-existent-room');

        expect(players).toEqual([]);
      });
    });
  });

  describe('GameGateway - GM Socket Events', () => {
    let roomCode: string;

    beforeEach(() => {
      const room = roomService.createRoom('gm-socket-id', 0, 'GameMaster');
      roomCode = room.roomCode;
    });

    describe('handleGmGetPlayers', () => {
      it('should emit players update to GM room', () => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);

        gameGateway.handleGmGetPlayers(mockSocket as any, { roomCode });

        expect(mockServer.to).toHaveBeenCalledWith(`gm_${roomCode}`);
        expect(mockServer.emit).toHaveBeenCalledWith('gm:playersUpdate', {
          players: expect.arrayContaining([
            expect.objectContaining({ id: mockPlayer.id }),
            expect.objectContaining({ status: 'gm' }),
          ]),
        });
      });

      it('should emit error for non-host socket', () => {
        const nonHostSocket = { ...mockSocket, id: 'non-host-id' };

        gameGateway.handleGmGetPlayers(nonHostSocket as any, { roomCode });

        expect(nonHostSocket.emit).toHaveBeenCalledWith(
          'room:updatePlayersError',
          {
            message: 'Not authorized.',
          },
        );
      });
    });

    describe('handleGmEliminatePlayer', () => {
      beforeEach(() => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);
      });

      it('should eliminate player and emit updates', () => {
        gameGateway.handleGmEliminatePlayer(mockSocket as any, {
          roomCode,
          playerId: mockPlayer.id,
          reason: 'Test elimination',
        });

        expect(mockServer.to).toHaveBeenCalledWith(`gm_${roomCode}`);
        expect(mockServer.to).toHaveBeenCalledWith(roomCode);
        expect(mockServer.emit).toHaveBeenCalledWith('gm:playersUpdate', {
          players: expect.arrayContaining([
            expect.objectContaining({ id: mockPlayer.id, alive: false }),
          ]),
        });
        expect(mockServer.emit).toHaveBeenCalledWith('gm:nightAction', {
          step: 'gm_elimination',
          action: 'eliminate',
          message: `GM đã loại bỏ ${mockPlayer.username}: Test elimination`,
          timestamp: expect.any(Number),
        });
      });

      it('should emit error for non-host socket', () => {
        const nonHostSocket = { ...mockSocket, id: 'non-host-id' };

        gameGateway.handleGmEliminatePlayer(nonHostSocket as any, {
          roomCode,
          playerId: mockPlayer.id,
          reason: 'Test elimination',
        });

        expect(nonHostSocket.emit).toHaveBeenCalledWith(
          'gm:eliminatePlayerError',
          {
            message: 'Not authorized.',
          },
        );
      });

      it('should emit error for failed elimination', () => {
        gameGateway.handleGmEliminatePlayer(mockSocket as any, {
          roomCode,
          playerId: 'non-existent-id',
          reason: 'Test elimination',
        });

        expect(mockSocket.emit).toHaveBeenCalledWith(
          'gm:eliminatePlayerError',
          {
            message: 'Failed to eliminate player.',
          },
        );
      });
    });

    describe('handleGmRevivePlayer', () => {
      beforeEach(() => {
        roomService.addPlayer(roomCode, mockPlayer);
        roomService.approvePlayer(roomCode, mockPlayer.id);
        roomService.eliminatePlayer(roomCode, mockPlayer.id);
      });

      it('should revive player and emit updates', () => {
        gameGateway.handleGmRevivePlayer(mockSocket as any, {
          roomCode,
          playerId: mockPlayer.id,
        });

        expect(mockServer.to).toHaveBeenCalledWith(`gm_${roomCode}`);
        expect(mockServer.to).toHaveBeenCalledWith(roomCode);
        expect(mockServer.emit).toHaveBeenCalledWith('gm:playersUpdate', {
          players: expect.arrayContaining([
            expect.objectContaining({ id: mockPlayer.id, alive: true }),
          ]),
        });
        expect(mockServer.emit).toHaveBeenCalledWith('gm:nightAction', {
          step: 'gm_revival',
          action: 'revive',
          message: `GM đã hồi sinh ${mockPlayer.username}`,
          timestamp: expect.any(Number),
        });
      });

      it('should emit error for non-host socket', () => {
        const nonHostSocket = { ...mockSocket, id: 'non-host-id' };

        gameGateway.handleGmRevivePlayer(nonHostSocket as any, {
          roomCode,
          playerId: mockPlayer.id,
        });

        expect(nonHostSocket.emit).toHaveBeenCalledWith(
          'gm:revivePlayerError',
          {
            message: 'Not authorized.',
          },
        );
      });

      it('should emit error for failed revival', () => {
        gameGateway.handleGmRevivePlayer(mockSocket as any, {
          roomCode,
          playerId: 'non-existent-id',
        });

        expect(mockSocket.emit).toHaveBeenCalledWith('gm:revivePlayerError', {
          message: 'Failed to revive player.',
        });
      });
    });

    describe('handleNextPhase', () => {
      it('should handle phase transitions correctly', () => {
        const mockGameState = {
          phase: 'night',
          players: [mockPlayer],
          witch: { healUsed: false, poisonUsed: false },
          votes: {},
        };

        jest
          .spyOn(phaseManager['gameStates'], 'get')
          .mockReturnValue(mockGameState as any);
        jest.spyOn(phaseManager, 'startDayPhase').mockImplementation();

        gameGateway.handleNextPhase(mockSocket as any, { roomCode });

        expect(phaseManager.startDayPhase).toHaveBeenCalledWith(roomCode);
      });

      it('should emit error for non-existent game state', () => {
        jest
          .spyOn(phaseManager['gameStates'], 'get')
          .mockReturnValue(undefined);

        gameGateway.handleNextPhase(mockSocket as any, { roomCode });

        expect(mockSocket.emit).toHaveBeenCalledWith('room:phaseError', {
          message: 'Game state not found.',
        });
      });
    });
  });

  describe('PhaseManager - GM Notifications', () => {
    let roomCode: string;
    let gmRoomId: string;

    beforeEach(() => {
      roomCode = 'TEST123';
      gmRoomId = `gm_${roomCode}`;
      phaseManager.initGameState(roomCode, [mockPlayer], gmRoomId);
    });

    describe('startDayPhase', () => {
      it('should emit GM notification for day phase', () => {
        phaseManager.startDayPhase(roomCode);

        expect(mockServer.to).toHaveBeenCalledWith(roomCode);
        expect(mockServer.to).toHaveBeenCalledWith(gmRoomId);
        expect(mockServer.emit).toHaveBeenCalledWith('game:phaseChanged', {
          phase: 'day',
        });
        expect(mockServer.emit).toHaveBeenCalledWith('gm:votingAction', {
          type: 'phaseChanged',
          message: 'Chuyển sang giai đoạn ngày, các bạn có thể thảo luận.',
        });
      });
    });

    describe('startVotingPhase', () => {
      it('should emit GM notification for voting phase', () => {
        phaseManager.startVotingPhase(roomCode);

        expect(mockServer.to).toHaveBeenCalledWith(roomCode);
        expect(mockServer.to).toHaveBeenCalledWith(gmRoomId);
        expect(mockServer.emit).toHaveBeenCalledWith('game:phaseChanged', {
          phase: 'voting',
        });
        expect(mockServer.emit).toHaveBeenCalledWith('gm:votingAction', {
          type: 'phaseChanged',
          message:
            'Chuyển sang giai đoạn bỏ phiếu, các bạn có 1 phút để bỏ phiếu.',
        });
      });
    });

    describe('checkWinCondition', () => {
      it('should emit GM notification when game ends', () => {
        const werewolfPlayer: Player = {
          ...mockPlayer,
          id: 'werewolf-1',
          role: 'werewolf',
          alive: false,
        };

        phaseManager.initGameState(roomCode, [mockPlayer], gmRoomId);
        const state = phaseManager['gameStates'].get(roomCode);
        if (state) {
          state.players = [mockPlayer];
        }

        const winner = phaseManager.checkWinCondition(roomCode);

        expect(winner).toBe('villagers');
        expect(mockServer.to).toHaveBeenCalledWith(roomCode);
        expect(mockServer.to).toHaveBeenCalledWith(gmRoomId);
        expect(mockServer.emit).toHaveBeenCalledWith('game:gameEnded', {
          winner: 'villagers',
        });
        expect(mockServer.emit).toHaveBeenCalledWith('gm:gameEnded', {
          type: 'gameEnded',
          message: 'Trò chơi kết thúc. Dân làng thắng!',
          winner: 'villagers',
        });
      });
    });
  });
});
