/**
 * Fake timer helpers that work correctly with async/await.
 *
 * Usage in tests:
 *
 *   beforeEach(() => { jest.useFakeTimers(); });
 *   afterEach(() => { jest.useRealTimers(); });
 *
 * Then call drainPromisesAndTimers() to process microtasks + timers together.
 */

const ROLE_TIMEOUT_MS: Record<string, number> = {
  bodyguard: 30000,
  werewolf: 60000,
  witch: 30000,
  seer: 30000,
  voting: 60000,
};

/**
 * Advance fake timers by the exact timeout duration for a given role.
 * Must be called with jest.useFakeTimers() active.
 */
export function advanceTimersByRoleTimeout(role: string): void {
  const ms = ROLE_TIMEOUT_MS[role];
  if (!ms) throw new Error(`Unknown role timeout for: ${role}`);
  jest.advanceTimersByTime(ms);
}

/**
 * Flush all pending microtasks (Promise callbacks) then run all pending
 * fake timers — repeating until stable.
 *
 * This is the correct pattern for mixing async/await with jest.useFakeTimers().
 * Call this inside an async test function.
 */
export async function drainPromisesAndTimers(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    jest.runAllTimers();
  }
}

/**
 * Flush only pending microtasks (no timer advancement).
 */
export async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
