import { PhaseManager, GameState } from '../../service/phase-manager.service';
import { Player } from '../../types';

jest.useFakeTimers();

describe('PhaseManager E2E Game Flow', () => {
  let phaseManager: PhaseManager;
  let server: any;
  let roomId: string;
  let players: Player[];
  let emits: { event: string; payload: any }[];

  beforeAll(() => {
    server = {
      to: jest.fn(() => ({
        emit: jest.fn((event: string, payload: any) =>
          emits.push({ event, payload }),
        ),
      })),
    };
    phaseManager = new PhaseManager();
    phaseManager.setServer(server as any);
  });

  beforeEach(() => {
    roomId = 'test-room';
    players = [
      {
        id: 'p1',
        username: 'Wolf1',
        avatarKey: 1,
        status: 'approved',
        alive: true,
        role: 'werewolf',
      },
      {
        id: 'p2',
        username: 'Wolf2',
        avatarKey: 2,
        status: 'approved',
        alive: true,
        role: 'werewolf',
      },
      {
        id: 'p3',
        username: 'Seer',
        avatarKey: 3,
        status: 'approved',
        alive: true,
        role: 'seer',
      },
      {
        id: 'p4',
        username: 'Witch',
        avatarKey: 4,
        status: 'approved',
        alive: true,
        role: 'witch',
      },
      {
        id: 'p5',
        username: 'Bodyguard',
        avatarKey: 5,
        status: 'approved',
        alive: true,
        role: 'bodyguard',
      },
      {
        id: 'p6',
        username: 'Villager1',
        avatarKey: 6,
        status: 'approved',
        alive: true,
        role: 'villager',
      },
      {
        id: 'p7',
        username: 'Villager2',
        avatarKey: 7,
        status: 'approved',
        alive: true,
        role: 'villager',
      },
      {
        id: 'p8',
        username: 'Hunter',
        avatarKey: 8,
        status: 'approved',
        alive: true,
        role: 'hunter',
      },
    ];
    emits = [];
    // Do NOT mock emitToRoleAndWaitResponse here
  });

  function getState(): GameState {
    return (phaseManager as any).getGameState(roomId) as GameState;
  }

  function respondVote(playerId: string, targetId: string) {
    phaseManager.handleVotingResponse(roomId, playerId, targetId);
  }

  it('should handle hunter auto-shoot on death (night or vote)', async () => {
    phaseManager.initGameState(roomId, players);
    const nightPhasePromise = phaseManager.startNightPhase(roomId);
    // Simulate all role responses in order
    phaseManager.handleRoleResponse(roomId, 'p1', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p2', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p3', { targetId: 'p2' });
    phaseManager.handleRoleResponse(roomId, 'p4', {
      heal: true,
      poisonTargetId: 'p2',
    });
    phaseManager.handleRoleResponse(roomId, 'p5', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p8', { targetId: 'p3' });
    await nightPhasePromise;
    jest.runAllTimers();
    // Không assert state ở đây, chỉ assert sau khi voting và hunter chết
    phaseManager.startVotingPhase(roomId);
    respondVote('p1', 'p8');
    respondVote('p2', 'p8');
    respondVote('p3', 'p8');
    respondVote('p4', 'p8');
    respondVote('p5', 'p8');
    respondVote('p6', 'p8');
    respondVote('p7', 'p8');
    respondVote('p8', 'p8');
    jest.runAllTimers();
    const state = getState();
    // Hunter should be dead
    expect(state.players.find((p) => p.id === 'p8')?.alive).toBe(false);
    // Hunter's target (p3) should also be dead automatically
    expect(state.players.find((p) => p.id === 'p3')?.alive).toBe(false);
  });

  it('should allow seer to check correct role', async () => {
    phaseManager.initGameState(roomId, players);
    const nightPhasePromise = phaseManager.startNightPhase(roomId);
    phaseManager.handleRoleResponse(roomId, 'p1', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p2', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p3', { targetId: 'p2' });
    phaseManager.handleRoleResponse(roomId, 'p4', {
      heal: true,
      poisonTargetId: 'p2',
    });
    phaseManager.handleRoleResponse(roomId, 'p5', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p8', { targetId: 'p3' });
    await nightPhasePromise;
    jest.runAllTimers();
    const state = getState();
    expect(state.seerTarget).toBe('p2');
    const seerChecked = state.players.find((p) => p.id === state.seerTarget);
    expect(seerChecked?.role).toBe('werewolf');
  });

  it('should allow witch to heal and poison correctly', async () => {
    phaseManager.initGameState(roomId, players);
    const nightPhasePromise = phaseManager.startNightPhase(roomId);
    phaseManager.handleRoleResponse(roomId, 'p1', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p2', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p3', { targetId: 'p2' });
    phaseManager.handleRoleResponse(roomId, 'p4', {
      heal: true,
      poisonTargetId: 'p2',
    });
    phaseManager.handleRoleResponse(roomId, 'p5', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p8', { targetId: 'p3' });
    await nightPhasePromise;
    jest.runAllTimers();
    const state = getState();
    expect(state.witch.healUsed).toBe(true);
    expect(state.witch.healTarget).toBe(state.werewolfTarget);
    expect(state.witch.poisonUsed).toBe(true);
    expect(state.witch.poisonTarget).toBe('p2');
  });

  it('should allow bodyguard to protect a player', async () => {
    phaseManager.initGameState(roomId, players);
    const nightPhasePromise = phaseManager.startNightPhase(roomId);
    phaseManager.handleRoleResponse(roomId, 'p1', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p2', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p3', { targetId: 'p2' });
    phaseManager.handleRoleResponse(roomId, 'p4', {
      heal: true,
      poisonTargetId: 'p2',
    });
    phaseManager.handleRoleResponse(roomId, 'p5', { targetId: 'p8' });
    phaseManager.handleRoleResponse(roomId, 'p8', { targetId: 'p3' });
    await nightPhasePromise;
    jest.runAllTimers();
    const state = getState();
    expect(state.bodyguardTarget).toBe('p8');
    expect(state.lastProtected).toBe('p8');
  });

  it('should handle voting and eliminate correct player', async () => {
    phaseManager.initGameState(roomId, players);
    phaseManager.startVotingPhase(roomId);
    respondVote('p1', 'p6');
    respondVote('p2', 'p6');
    respondVote('p3', 'p6');
    respondVote('p4', 'p6');
    respondVote('p5', 'p6');
    respondVote('p6', 'p6');
    respondVote('p7', 'p6');
    respondVote('p8', 'p6');
    jest.runAllTimers();
    const state = getState();
    expect(state.players.find((p) => p.id === 'p6')?.alive).toBe(false);
  });
});
