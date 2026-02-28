import { PhaseManager } from '../../service/phase-manager.service';
import { RoomService } from '../../service/room.service';
import { GameState } from '../../service/game-engine';
import { createMockSocketServer } from '../helpers/mock-server';
import { createStandardPlayers } from '../fixtures/players';

/**
 * Helper class to expose private GameState for test assertions.
 *
 * PhaseManager stores game state in a private Map. Instead of using `as any`,
 * we subclass and expose a getter for testing purposes.
 */
class TestablePhaseManager extends PhaseManager {
  constructor(roomService: RoomService) {
    super(roomService);
  }

  getGameStateForTest(roomId: string): GameState | undefined {
    return (this as any).gameStates.get(roomId);
  }
}

describe('PhaseManager Integration', () => {
  let phaseManager: TestablePhaseManager;
  let roomService: RoomService;
  let mockServer: ReturnType<typeof createMockSocketServer>;
  let roomId: string;

  beforeEach(() => {
    roomService = new RoomService();
    // Clear the RoomService cleanup interval
    clearInterval((roomService as any).cleanupTimer);

    phaseManager = new TestablePhaseManager(roomService);
    mockServer = createMockSocketServer();

    phaseManager.setServer(mockServer.server as any);

    // Create a test room with approved players
    const room = roomService.createRoom('gm-socket', 1, 'GameMaster');
    roomId = room.roomCode;

    const players = createStandardPlayers();
    players.forEach((p) => {
      if (p.status === 'approved') {
        roomService.addPlayer(roomId, {
          ...p,
          id: `socket-${p.id}`,
          persistentId: p.persistentId,
        });
        roomService.approvePlayer(roomId, `socket-${p.id}`);
      }
    });

    const approvedPlayers = roomService
      .getPlayers(roomId)
      .filter((p) => p.status === 'approved');
    phaseManager.initGameState(roomId, approvedPlayers, 'gm-room-123');

    mockServer.reset();
  });

  afterEach(() => {
    roomService.onModuleDestroy();
  });

  // ── Night phase — core logic (without timers) ───────────────────────────────

  describe('startNightPhase — core logic', () => {
    it('should initialize game state correctly', () => {
      const state = phaseManager.getGameStateForTest(roomId);
      expect(state?.phase).toBeNull();
      expect(state?.players).toHaveLength(8);
    });

    it('should handle role responses gracefully when no pending responses', () => {
      // handleRoleResponse is a no-op when pendingResponses is not set up
      // (which happens during startNightPhase via emitToRoleAndWaitResponse)
      // This test verifies it doesn't crash or throw
      expect(() => {
        phaseManager.handleRoleResponse(roomId, 'socket-p5', {
          targetId: 'socket-p6',
        });
        phaseManager.handleRoleResponse(roomId, 'socket-p1', {
          targetId: 'socket-p8',
        });
        phaseManager.handleRoleResponse(roomId, 'socket-p2', {
          targetId: 'socket-p8',
        });
        phaseManager.handleRoleResponse(roomId, 'socket-p4', { heal: true });
        phaseManager.handleRoleResponse(roomId, 'socket-p3', {
          targetId: 'socket-p1',
        });
      }).not.toThrow();

      // State should be unchanged (no night actions applied)
      const state = phaseManager.getGameStateForTest(roomId);
      expect(state?.bodyguardTarget).toBeUndefined();
      expect(state?.seerTarget).toBeUndefined();
    });
  });

  // ── Voting phase — core logic ───────────────────────────────────────────────

  describe('startVotingPhase', () => {
    it('should initialize voting state', () => {
      phaseManager.startVotingPhase(roomId);

      const state = phaseManager.getGameStateForTest(roomId);
      expect(state?.phase).toBe('voting');
      expect(state?.votingResolved).toBe(false);
      expect(state?.votes).toEqual({});
    });

    it('should record votes and trigger phase resolution when all players vote', () => {
      phaseManager.startVotingPhase(roomId);

      const state = phaseManager.getGameStateForTest(roomId)!;

      // Ensure all players are alive
      state.players.forEach((p) => {
        p.alive = true;
      });

      const alivePlayers = state.players.filter((p) => p.alive);

      // Simulate all players voting for socket-p6 (a villager — not hunter/tanner)
      // Vote for a player who is NOT socket-p6 themselves to avoid self-vote issues;
      // pick socket-p7 as the target so socket-p6 can also vote
      const target = 'socket-p7';
      alivePlayers.forEach((player) => {
        phaseManager.handleVotingResponse(roomId, player.id, target);
      });

      // After all players vote, handleVoting resolves, resets voting state,
      // and transitions to 'conclude' phase
      expect(state.phase).toBe('conclude');

      // votes and actionsReceived are cleared by resetVotingState
      expect(Object.keys(state.votes).length).toBe(0);
    });
  });

  // ── Win conditions ───────────────────────────────────────────────────────────

  describe('checkWinCondition', () => {
    it('should detect villagers win when all werewolves are dead', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;

      // Kill all werewolves
      state.players.forEach((p) => {
        if (p.role === 'werewolf') p.alive = false;
      });

      const winner = phaseManager.checkWinCondition(roomId);
      expect(winner).toBe('villagers');
      expect(phaseManager.getGameStateForTest(roomId)?.phase).toBe('ended');
    });

    it('should detect werewolves win when they outnumber villagers', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;

      // Kill enough non-werewolves
      state.players.forEach((p, i) => {
        if (i >= 2 && i <= 5 && p.role !== 'werewolf') p.alive = false;
      });

      const winner = phaseManager.checkWinCondition(roomId);
      expect(winner).toBe('werewolves');
    });
  });

  // ── Hunter shoot ─────────────────────────────────────────────────────────────

  describe('handleHunterDeathShoot', () => {
    it('should handle hunter shooting after being voted out', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      const hunter = state.players.find((p) => p.role === 'hunter')!;

      // Kill the hunter
      hunter.alive = false;
      state.phase = 'voting';
      state.votingResolved = true;

      phaseManager.handleHunterDeathShoot(roomId, hunter.id, 'socket-p1');

      const finalState = phaseManager.getGameStateForTest(roomId);
      const target = finalState?.players.find((p) => p.id === 'socket-p1');
      expect(target?.alive).toBe(false);
    });

    it('should allow hunter to skip shooting', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      const hunter = state.players.find((p) => p.role === 'hunter')!;
      hunter.alive = false;
      state.phase = 'voting';
      state.votingResolved = true;

      phaseManager.handleHunterDeathShoot(roomId, hunter.id, undefined);

      // Should not throw, phase should be able to continue
      const finalState = phaseManager.getGameStateForTest(roomId);
      expect(finalState).toBeDefined();
    });
  });

  // ── State management ─────────────────────────────────────────────────────────

  describe('State sync and cleanup', () => {
    it('should sync player alive status when player is eliminated', () => {
      const player = roomService
        .getPlayers(roomId)
        .find((p) => p.persistentId === 'pid-p1')!;
      expect(player?.alive).toBe(true);

      phaseManager.eliminatePlayer(roomId, player.id);

      expect(player?.alive).toBe(false);
    });

    it('should cleanup room state on cleanupRoom', () => {
      const beforeState = phaseManager.getGameStateForTest(roomId);
      expect(beforeState).toBeDefined();

      phaseManager.cleanupRoom(roomId);

      const afterState = phaseManager.getGameStateForTest(roomId);
      expect(afterState).toBeUndefined();
    });

    it('should update player socket ID on reconnection', () => {
      phaseManager.updatePlayerSocketId(roomId, 'pid-p1', 'new-socket-id');

      const state = phaseManager.getGameStateForTest(roomId);
      const player = state?.players.find(
        (p) => (p as { persistentId?: string }).persistentId === 'pid-p1',
      );
      expect(player?.id).toBe('new-socket-id');
    });
  });

  // ── Transition locks ─────────────────────────────────────────────────────────

  describe('transition locks', () => {
    it('should reject concurrent startNightPhase calls', () => {
      // Start the first phase (don't await)
      // eslint-disable-next-line
      const promise1 = phaseManager.startNightPhase(roomId);

      // The second call should be ignored (no error thrown)
      void phaseManager.startNightPhase(roomId);

      // Only one phase transition should occur (we check immediately, not waiting)
      expect(phaseManager.getGameStateForTest(roomId)?.round).toBe(1);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle invalid roomId gracefully in handleRoleResponse', () => {
      // Should not throw
      expect(() => {
        phaseManager.handleRoleResponse('nonexistent-room', 'socket-1', {
          targetId: 'socket-2',
        });
      }).not.toThrow();
    });

    it('should handle invalid roomId in startVotingPhase', () => {
      // Should not throw
      expect(() => {
        phaseManager.startVotingPhase('nonexistent-room');
      }).not.toThrow();
    });
  });
});
