import { Player, Role } from '../../types';
import { GameEngine, GameState } from '../../service/game-engine';

/**
 * Returns an 8-player fixture covering all 7 roles (2 werewolves).
 *
 * Role layout:
 *   p1 = werewolf  (Wolf1)
 *   p2 = werewolf  (Wolf2)
 *   p3 = seer      (Seer)
 *   p4 = witch     (Witch)
 *   p5 = bodyguard (Bodyguard)
 *   p6 = villager  (Villager1)
 *   p7 = villager  (Villager2)
 *   p8 = hunter    (Hunter)
 */
export function createStandardPlayers(): Player[] {
  return [
    {
      id: 'p1',
      persistentId: 'pid-p1',
      username: 'Wolf1',
      avatarKey: 1,
      status: 'approved',
      alive: true,
      role: 'werewolf',
    },
    {
      id: 'p2',
      persistentId: 'pid-p2',
      username: 'Wolf2',
      avatarKey: 2,
      status: 'approved',
      alive: true,
      role: 'werewolf',
    },
    {
      id: 'p3',
      persistentId: 'pid-p3',
      username: 'Seer',
      avatarKey: 3,
      status: 'approved',
      alive: true,
      role: 'seer',
    },
    {
      id: 'p4',
      persistentId: 'pid-p4',
      username: 'Witch',
      avatarKey: 4,
      status: 'approved',
      alive: true,
      role: 'witch',
    },
    {
      id: 'p5',
      persistentId: 'pid-p5',
      username: 'Bodyguard',
      avatarKey: 5,
      status: 'approved',
      alive: true,
      role: 'bodyguard',
    },
    {
      id: 'p6',
      persistentId: 'pid-p6',
      username: 'Villager1',
      avatarKey: 6,
      status: 'approved',
      alive: true,
      role: 'villager',
    },
    {
      id: 'p7',
      persistentId: 'pid-p7',
      username: 'Villager2',
      avatarKey: 7,
      status: 'approved',
      alive: true,
      role: 'villager',
    },
    {
      id: 'p8',
      persistentId: 'pid-p8',
      username: 'Hunter',
      avatarKey: 8,
      status: 'approved',
      alive: true,
      role: 'hunter',
    },
  ];
}

/**
 * Generates a minimal player list for a custom role set.
 * Player IDs are p1, p2, ... in order.
 */
export function createMinimalPlayers(roles: Role[]): Player[] {
  return roles.map((role, i) => ({
    id: `p${i + 1}`,
    username: `Player${i + 1}`,
    avatarKey: i + 1,
    status: 'approved' as const,
    alive: true,
    role,
  }));
}

/**
 * Creates a GameState from the standard 8-player fixture with optional overrides.
 */
export function createGameState(overrides: Partial<GameState> = {}): GameState {
  const base = GameEngine.createInitialState(createStandardPlayers());
  return { ...base, ...overrides };
}
