import { PhaseManager } from '../../service/phase-manager.service';
import { RoomService } from '../../service/room.service';
import { GameState, RoleResponse } from '../../service/game-engine';
import { createMockSocketServer } from '../helpers/mock-server';
import { createStandardPlayers } from '../fixtures/players';

/**
 * Helper class to expose private GameState for test assertions.
 *
 * PhaseManager stores game state in a private Map. Instead of using `as any`,
 * we subclass and expose a getter for testing purposes.
 */
class TestablePhaseManager extends PhaseManager {
  constructor(
    roomService: RoomService,
    delayFn?: (ms: number) => Promise<void>,
  ) {
    super(roomService);
    if (delayFn) this.delayFn = delayFn;
  }

  getGameStateForTest(roomId: string): GameState | undefined {
    return (this as any).gameStates.get(roomId);
  }

  hasPendingResponse(roomId: string): boolean {
    return (this as any).pendingResponses.has(roomId);
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
    phaseManager.cleanupRoom(roomId);
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

      // Kill the hunter and set up hunter shooting state
      hunter.alive = false;
      state.phase = 'voting';
      state.votingResolved = true;
      state.hunterShooting = true;
      state.hunterDeathContext = 'vote';

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
      state.hunterShooting = true;
      state.hunterDeathContext = 'vote';

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

// ── Night phase — full cycle with zero-delay ──────────────────────────────────

describe('PhaseManager — full night cycle (zero-delay)', () => {
  let phaseManager: TestablePhaseManager;
  let roomService: RoomService;
  let mockServer: ReturnType<typeof createMockSocketServer>;
  let roomId: string;

  const zeroDelay = () => Promise.resolve();

  beforeEach(() => {
    roomService = new RoomService();
    clearInterval((roomService as any).cleanupTimer);

    phaseManager = new TestablePhaseManager(roomService, zeroDelay);
    mockServer = createMockSocketServer();
    phaseManager.setServer(mockServer.server as any);

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
    phaseManager.cleanupRoom(roomId);
    roomService.onModuleDestroy();
  });

  /** Helper: Poll until pendingResponses is registered, then submit responses */
  async function submitWhenReady(
    roleId: string,
    payload: RoleResponse,
    werewolfPartnerId?: string,
    werewolfTarget?: string,
  ): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (phaseManager.hasPendingResponse(roomId)) {
        phaseManager.handleRoleResponse(roomId, roleId, payload);
        if (werewolfPartnerId && werewolfTarget) {
          phaseManager.handleRoleResponse(roomId, werewolfPartnerId, {
            targetId: werewolfTarget,
          });
        }
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('pendingResponses never registered');
  }

  it('should complete a full night phase when all roles submit responses', async () => {
    const nightPromise = phaseManager.startNightPhase(roomId);

    // Bodyguard: protect socket-p6
    await submitWhenReady('socket-p5', { targetId: 'socket-p6' });

    // Werewolves: both target socket-p6
    await submitWhenReady(
      'socket-p1',
      { targetId: 'socket-p6' },
      'socket-p2',
      'socket-p6',
    );

    // Witch: skip
    await submitWhenReady('socket-p4', { heal: false });

    // Seer: check socket-p1
    await submitWhenReady('socket-p3', { targetId: 'socket-p1' });

    await nightPromise;

    const state = phaseManager.getGameStateForTest(roomId)!;
    // socket-p6 was targeted but bodyguard protected — should still be alive
    const p6 = state.players.find((p) => p.id === 'socket-p6');
    expect(p6?.alive).toBe(true);
    // A night_result log entry should have been recorded
    expect(state.gameLog.some((e) => e.type === 'night_result')).toBe(true);
  });

  it('should kill a player when werewolf target is unprotected', async () => {
    const nightPromise = phaseManager.startNightPhase(roomId);

    // Bodyguard: protect someone else (socket-p7)
    await submitWhenReady('socket-p5', { targetId: 'socket-p7' });

    // Werewolves: both target socket-p6 (unprotected)
    await submitWhenReady(
      'socket-p1',
      { targetId: 'socket-p6' },
      'socket-p2',
      'socket-p6',
    );

    // Witch: skip
    await submitWhenReady('socket-p4', { heal: false });

    // Seer: skip
    await submitWhenReady('socket-p3', {});

    await nightPromise;

    const state = phaseManager.getGameStateForTest(roomId)!;
    const p6 = state.players.find((p) => p.id === 'socket-p6');
    expect(p6?.alive).toBe(false);
  });

  it('should advance round counter after each night phase', async () => {
    const stateBefore = phaseManager.getGameStateForTest(roomId)!;
    expect(stateBefore.round).toBe(0);

    const nightPromise = phaseManager.startNightPhase(roomId);
    await submitWhenReady('socket-p5', { targetId: 'socket-p7' });
    await submitWhenReady(
      'socket-p1',
      { targetId: 'socket-p6' },
      'socket-p2',
      'socket-p6',
    );
    await submitWhenReady('socket-p4', { heal: false });
    await submitWhenReady('socket-p3', {});

    await nightPromise;

    expect(phaseManager.getGameStateForTest(roomId)?.round).toBe(1);
  });

  it('should emit game:phaseChanged(night) and game:nightResult events', async () => {
    const nightPromise = phaseManager.startNightPhase(roomId);
    await submitWhenReady('socket-p5', { targetId: 'socket-p7' });
    await submitWhenReady(
      'socket-p1',
      { targetId: 'socket-p6' },
      'socket-p2',
      'socket-p6',
    );
    await submitWhenReady('socket-p4', { heal: false });
    await submitWhenReady('socket-p3', {});

    await nightPromise;

    mockServer.expectEmitted('game:phaseChanged');
    mockServer.expectEmitted('game:nightResult');
  });
});
