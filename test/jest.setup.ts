/**
 * Global Jest setup file.
 * Runs after each test to prevent timer leaks and mock state pollution.
 */

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  jest.clearAllTimers();
});
