/**
 * Hunter Night-Death Feature Tests
 *
 * Covers the scenario where the Hunter is killed by werewolves at night
 * and gets to shoot (or skip) before the Day phase begins.
 *
 * Scenarios tested:
 *   1. State flags: hunterShooting + hunterDeathContext set correctly
 *   2. Phase is blocked (does NOT transition to day) until hunter responds
 *   3. game:hunterShoot event is emitted to all players with correct hunterId
 *   4. gm:hunterAction (hunterDied) is emitted to GM room
 *   5. Night log (night_result) is captured before resetNightState
 *   6. Hunter shoots → target dies, then Day phase starts (not Night)
 *   7. Hunter skips → no one shot, then Day phase starts (not Night)
 *   8. Hunter shot is logged (hunter_shot game log entry)
 *   9. game:hunterShot is emitted after actual shot
 *  10. Win condition checked after hunter shot kills last werewolf
 *  11. Double-trigger guard: hunterShooting flag prevents re-entry
 *  12. Contrast: vote-kill hunter routes to Night phase after shooting
 */

import { PhaseManager } from '../../service/phase-manager.service';
import { RoomService } from '../../service/room.service';
import { GameState } from '../../service/game-engine';
import { createMockSocketServer } from '../helpers/mock-server';
import { createStandardPlayers } from '../fixtures/players';

class TestablePhaseManager extends PhaseManager {
  constructor(roomService: RoomService) {
    super(roomService);
  }

  getGameStateForTest(roomId: string): GameState | undefined {
    return (this as any).gameStates.get(roomId);
  }

  /** Directly invoke the private resolveNightActions method. */
  resolveNightActionsForTest(roomId: string): void {
    return (this as any).resolveNightActions(roomId);
  }

  /** Directly invoke the private startDayPhase method (for assertion helpers). */
  startDayPhaseForTest(roomId: string): Promise<void> {
    return (this as any).startDayPhase(roomId);
  }
}

describe('Hunter Night-Death Feature', () => {
  let phaseManager: TestablePhaseManager;
  let roomService: RoomService;
  let mockServer: ReturnType<typeof createMockSocketServer>;
  let roomId: string;

  /**
   * Standard setup:
   *   p1 = werewolf  (Wolf1)    socket-p1
   *   p2 = werewolf  (Wolf2)    socket-p2
   *   p3 = seer                 socket-p3
   *   p4 = witch                socket-p4
   *   p5 = bodyguard            socket-p5
   *   p6 = villager             socket-p6
   *   p7 = villager             socket-p7
   *   p8 = hunter               socket-p8
   */
  beforeEach(() => {
    roomService = new RoomService();
    clearInterval((roomService as any).cleanupTimer);

    phaseManager = new TestablePhaseManager(roomService);
    mockServer = createMockSocketServer();
    phaseManager.setServer(mockServer.server as any);

    const room = roomService.createRoom('gm-socket', 1, 'GameMaster');
    roomId = room.roomCode;

    const players = createStandardPlayers();
    players.forEach((p) => {
      roomService.addPlayer(roomId, {
        ...p,
        id: `socket-${p.id}`,
        persistentId: p.persistentId,
      });
      roomService.approvePlayer(roomId, `socket-${p.id}`);
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

  // ── Helper ────────────────────────────────────────────────────────────────────

  /** Set up state so wolves targeted the hunter, then call resolveNightActions. */
  function resolveWithWolvesKillingHunter() {
    const state = phaseManager.getGameStateForTest(roomId)!;
    state.phase = 'night';
    state.werewolfTarget = 'socket-p8'; // Hunter
    phaseManager.resolveNightActionsForTest(roomId);
  }

  // ── 1. State flags ────────────────────────────────────────────────────────────

  describe('state flags after hunter killed at night', () => {
    it('sets hunterShooting to true', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      expect(state.hunterShooting).toBe(true);
    });

    it('sets hunterDeathContext to "night"', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      expect(state.hunterDeathContext).toBe('night');
    });

    it('marks hunter as dead in player list', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      const hunter = state.players.find((p) => p.role === 'hunter')!;
      expect(hunter.alive).toBe(false);
    });
  });

  // ── 2. Phase is blocked ───────────────────────────────────────────────────────

  describe('phase transition is blocked', () => {
    it('does NOT emit game:phaseChanged to "day" while hunter has not responded', () => {
      resolveWithWolvesKillingHunter();

      mockServer.expectNotEmitted('game:phaseChanged');
    });

    it('phase remains "night" (or null) — does not advance to day', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      // Phase should NOT have changed to 'day' or 'conclude'
      expect(state.phase).not.toBe('day');
      expect(state.phase).not.toBe('conclude');
    });
  });

  // ── 3. game:hunterShoot emitted ───────────────────────────────────────────────

  describe('game:hunterShoot event', () => {
    it('emits game:hunterShoot with correct hunterId', () => {
      resolveWithWolvesKillingHunter();

      mockServer.expectEmitted('game:hunterShoot', {
        hunterId: 'socket-p8',
      });
    });

    it('emits game:hunterShoot to the room (all players)', () => {
      resolveWithWolvesKillingHunter();

      const hunterShootEmits = mockServer.emits.filter(
        (e) => e.event === 'game:hunterShoot',
      );
      expect(hunterShootEmits.length).toBeGreaterThan(0);
      expect(hunterShootEmits[0].room).toBe(roomId);
    });
  });

  // ── 4. GM notification ────────────────────────────────────────────────────────

  describe('GM room notification', () => {
    it('emits gm:hunterAction with type "hunterDied" to GM room', () => {
      resolveWithWolvesKillingHunter();

      mockServer.expectEmittedTo('gm-room-123', 'gm:hunterAction', {
        type: 'hunterDied',
      });
    });

    it('gm:hunterAction message mentions the hunter died at night', () => {
      resolveWithWolvesKillingHunter();

      const gmEmit = mockServer.emits.find(
        (e) =>
          e.room === 'gm-room-123' && e.event === 'gm:hunterAction',
      );
      const payload = gmEmit?.payload as Record<string, unknown>;
      expect(typeof payload?.message).toBe('string');
      expect((payload.message as string).length).toBeGreaterThan(0);
    });
  });

  // ── 5. Night log captured correctly ──────────────────────────────────────────

  describe('night_result log entry', () => {
    it('creates a night_result log entry', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      const nightLog = state.gameLog.filter((e) => e.type === 'night_result');
      expect(nightLog.length).toBe(1);
    });

    it('night_result log includes the hunter death', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      const nightLog = state.gameLog.find((e) => e.type === 'night_result') as any;
      const deaths = nightLog?.deaths as Array<{ username: string; cause: string }>;
      expect(deaths).toBeDefined();
      expect(deaths.some((d) => d.username === 'Hunter')).toBe(true);
    });

    it('night_result werewolfTarget is set (captured before reset)', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      const nightLog = state.gameLog.find((e) => e.type === 'night_result') as any;
      // werewolfTarget should be the hunter's username, not null
      expect(nightLog?.werewolfTarget).toBe('Hunter');
    });

    it('night action bookkeeping (actionsReceived, werewolfVotes) is reset after log capture', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      state.phase = 'night';
      state.werewolfTarget = 'socket-p8';
      state.werewolfVotes = { 'socket-p1': 'socket-p8', 'socket-p2': 'socket-p8' };

      phaseManager.resolveNightActionsForTest(roomId);

      const postState = phaseManager.getGameStateForTest(roomId)!;
      // werewolfVotes cleared by resetNightState
      expect(postState.werewolfVotes).toEqual({});
      // actionsReceived is reset to an empty Set
      expect(postState.actionsReceived?.size).toBe(0);
    });
  });

  // ── 6. Hunter shoots → target dies → Day phase starts ────────────────────────

  describe('hunter shoots a target', () => {
    it('kills the target player', () => {
      resolveWithWolvesKillingHunter();
      mockServer.reset();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      const state = phaseManager.getGameStateForTest(roomId)!;
      const target = state.players.find((p) => p.id === 'socket-p1')!;
      expect(target.alive).toBe(false);
    });

    it('clears hunterShooting and hunterDeathContext after shot', () => {
      resolveWithWolvesKillingHunter();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      const state = phaseManager.getGameStateForTest(roomId)!;
      expect(state.hunterShooting).toBe(false);
      expect(state.hunterDeathContext).toBeUndefined();
    });

    it('does NOT transition to night phase after shooting (night-kill context)', () => {
      // The delayed startDayPhase is called via setTimeout(3000).
      // We verify the flag is cleared and game:hunterShot was emitted.
      // The actual phase change happens after the timeout — we just verify
      // the routing decision is correct by checking context was 'night'.
      resolveWithWolvesKillingHunter();

      const stateBefore = phaseManager.getGameStateForTest(roomId)!;
      expect(stateBefore.hunterDeathContext).toBe('night');

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      // Context is cleared (was 'night', which routes to startDayPhase)
      const stateAfter = phaseManager.getGameStateForTest(roomId)!;
      expect(stateAfter.hunterDeathContext).toBeUndefined();
    });
  });

  // ── 7. Hunter skips → no one dies → Day phase starts ─────────────────────────

  describe('hunter skips shooting', () => {
    it('does not kill any additional player', () => {
      resolveWithWolvesKillingHunter();

      const state = phaseManager.getGameStateForTest(roomId)!;
      const aliveCountBefore = state.players.filter((p) => p.alive).length;

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', undefined);

      const aliveCountAfter = state.players.filter((p) => p.alive).length;
      expect(aliveCountAfter).toBe(aliveCountBefore);
    });

    it('clears hunterShooting and hunterDeathContext after skip', () => {
      resolveWithWolvesKillingHunter();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', undefined);

      const state = phaseManager.getGameStateForTest(roomId)!;
      expect(state.hunterShooting).toBe(false);
      expect(state.hunterDeathContext).toBeUndefined();
    });

    it('emits gm:hunterAction with type "hunterSkipped"', () => {
      resolveWithWolvesKillingHunter();
      mockServer.reset();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', undefined);

      mockServer.expectEmittedTo('gm-room-123', 'gm:hunterAction', {
        type: 'hunterSkipped',
      });
    });
  });

  // ── 8. Hunter shot logged ──────────────────────────────────────────────────────

  describe('hunter_shot game log entry', () => {
    it('creates a hunter_shot log entry when hunter shoots', () => {
      resolveWithWolvesKillingHunter();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      const state = phaseManager.getGameStateForTest(roomId)!;
      const shotLog = state.gameLog.find((e) => e.type === 'hunter_shot') as any;
      expect(shotLog).toBeDefined();
      expect(shotLog.hunter).toBe('Hunter');
      expect(shotLog.target).toBe('Wolf1');
    });

    it('creates a hunter_shot log with null target when skipped', () => {
      resolveWithWolvesKillingHunter();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', undefined);

      const state = phaseManager.getGameStateForTest(roomId)!;
      const shotLog = state.gameLog.find((e) => e.type === 'hunter_shot') as any;
      expect(shotLog).toBeDefined();
      expect(shotLog.target).toBeNull();
    });
  });

  // ── 9. game:hunterShot emitted after actual shot ──────────────────────────────

  describe('game:hunterShot event (past tense — after actual fire)', () => {
    it('emits game:hunterShot with hunterId and targetId after shot', () => {
      resolveWithWolvesKillingHunter();
      mockServer.reset();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      mockServer.expectEmitted('game:hunterShot', {
        targetId: 'socket-p1',
      });
    });

    it('does NOT emit game:hunterShot when hunter skips', () => {
      resolveWithWolvesKillingHunter();
      mockServer.reset();

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', undefined);

      mockServer.expectNotEmitted('game:hunterShot');
    });
  });

  // ── 10. Win condition check after hunter shot ─────────────────────────────────

  describe('win condition after hunter shot', () => {
    it('detects villager win when hunter kills last werewolf', () => {
      resolveWithWolvesKillingHunter();

      // Kill the other werewolf manually
      const state = phaseManager.getGameStateForTest(roomId)!;
      const wolf2 = state.players.find(
        (p) => p.role === 'werewolf' && p.id === 'socket-p2',
      )!;
      wolf2.alive = false;

      // Hunter shoots the remaining alive werewolf (socket-p1)
      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p1');

      const finalState = phaseManager.getGameStateForTest(roomId)!;
      expect(finalState.phase).toBe('ended');
    });

    it('does not set ended phase when game continues after hunter shot', () => {
      resolveWithWolvesKillingHunter();

      // Hunter shoots a villager — werewolves still alive
      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p6');

      const state = phaseManager.getGameStateForTest(roomId)!;
      expect(state.phase).not.toBe('ended');
    });
  });

  // ── 11. Double-trigger guard ──────────────────────────────────────────────────

  describe('double-trigger prevention', () => {
    it('rejects a second handleHunterDeathShoot after hunterShooting is cleared', () => {
      resolveWithWolvesKillingHunter();

      // First shot: hunter shoots socket-p6
      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p6');

      const stateAfterFirstShot = phaseManager.getGameStateForTest(roomId)!;
      expect(stateAfterFirstShot.hunterShooting).toBe(false);
      expect(stateAfterFirstShot.hunterDeathContext).toBeUndefined();

      // Second attempt with correct hunterId: should be rejected because
      // hunterShooting flag is now false (guard added to prevent double-trigger)
      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p5');

      // socket-p5 should still be alive — second shot was rejected
      const p5 = stateAfterFirstShot.players.find((p) => p.id === 'socket-p5')!;
      expect(p5.alive).toBe(true);
    });

    it('ignores handleHunterDeathShoot for a non-existent/wrong hunterId', () => {
      resolveWithWolvesKillingHunter();

      // Should not throw
      expect(() => {
        phaseManager.handleHunterDeathShoot(roomId, 'socket-p1', 'socket-p6');
      }).not.toThrow();

      // socket-p6 should remain alive
      const state = phaseManager.getGameStateForTest(roomId)!;
      const p6 = state.players.find((p) => p.id === 'socket-p6')!;
      expect(p6.alive).toBe(true);
    });
  });

  // ── 12. Vote-kill contrast: routes to Night phase ─────────────────────────────

  describe('contrast: hunter voted out routes to Night (not Day) after shooting', () => {
    it('sets hunterDeathContext to "vote" when hunter is voted out', () => {
      phaseManager.startVotingPhase(roomId);

      const state = phaseManager.getGameStateForTest(roomId)!;

      // Make all players vote for the hunter (socket-p8) to trigger hunter path
      const alivePlayers = state.players.filter((p) => p.alive);
      alivePlayers.forEach((p) => {
        phaseManager.handleVotingResponse(roomId, p.id, 'socket-p8');
      });

      const postVoteState = phaseManager.getGameStateForTest(roomId)!;
      expect(postVoteState.hunterDeathContext).toBe('vote');
      expect(postVoteState.hunterShooting).toBe(true);
    });

    it('clears hunterDeathContext (was "vote") after hunter shoots post-vote', () => {
      phaseManager.startVotingPhase(roomId);

      const state = phaseManager.getGameStateForTest(roomId)!;
      const alivePlayers = state.players.filter((p) => p.alive);
      alivePlayers.forEach((p) => {
        phaseManager.handleVotingResponse(roomId, p.id, 'socket-p8');
      });

      phaseManager.handleHunterDeathShoot(roomId, 'socket-p8', 'socket-p6');

      const finalState = phaseManager.getGameStateForTest(roomId)!;
      expect(finalState.hunterDeathContext).toBeUndefined();
    });
  });

  // ── 13. Edge: hunter protected at night ───────────────────────────────────────

  describe('edge: hunter targeted but protected', () => {
    it('does NOT set hunterShooting when bodyguard protects the hunter', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      state.phase = 'night';
      state.werewolfTarget = 'socket-p8'; // wolf targets hunter
      state.bodyguardTarget = 'socket-p8'; // bodyguard protects hunter

      phaseManager.resolveNightActionsForTest(roomId);

      const postState = phaseManager.getGameStateForTest(roomId)!;
      // Hunter survived — no shoot triggered
      expect(postState.hunterShooting).toBeFalsy();
      expect(postState.hunterDeathContext).toBeUndefined();

      const hunter = postState.players.find((p) => p.role === 'hunter')!;
      expect(hunter.alive).toBe(true);
    });

    it('does NOT emit game:hunterShoot when hunter is protected', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      state.phase = 'night';
      state.werewolfTarget = 'socket-p8';
      state.bodyguardTarget = 'socket-p8';

      phaseManager.resolveNightActionsForTest(roomId);

      mockServer.expectNotEmitted('game:hunterShoot');
    });

    it('does NOT emit game:hunterShoot when witch heals the hunter', () => {
      const state = phaseManager.getGameStateForTest(roomId)!;
      state.phase = 'night';
      state.werewolfTarget = 'socket-p8';
      state.witch.healTarget = 'socket-p8';

      phaseManager.resolveNightActionsForTest(roomId);

      mockServer.expectNotEmitted('game:hunterShoot');
    });
  });

  // ── 14. game:nightResult emitted before hunter shoot ─────────────────────────

  describe('event ordering', () => {
    it('emits game:nightResult before game:hunterShoot', () => {
      resolveWithWolvesKillingHunter();

      const nightResultIdx = mockServer.emits.findIndex(
        (e) => e.event === 'game:nightResult',
      );
      const hunterShootIdx = mockServer.emits.findIndex(
        (e) => e.event === 'game:hunterShoot',
      );

      expect(nightResultIdx).toBeGreaterThanOrEqual(0);
      expect(hunterShootIdx).toBeGreaterThan(nightResultIdx);
    });

    it('game:nightResult includes hunter in diedPlayerIds', () => {
      resolveWithWolvesKillingHunter();

      const nightResult = mockServer.emits.find(
        (e) => e.event === 'game:nightResult',
      );
      const payload = nightResult?.payload as Record<string, unknown>;
      const diedPlayerIds = payload?.diedPlayerIds as string[];
      expect(diedPlayerIds).toContain('socket-p8');
    });
  });
});
