export interface EmitRecord {
  room: string;
  event: string;
  payload: unknown;
}

/**
 * Mock Socket.IO Server type.
 * Only includes the methods used by PhaseManager.
 */
export interface MockSocketServer {
  server: {
    to: jest.Mock & ((room: string) => { emit: jest.Mock });
  };
  emits: EmitRecord[];
  /** Assert at least one emission matching event + optional partial payload. */
  expectEmitted(event: string, partialPayload?: Record<string, unknown>): void;
  /** Assert at least one emission to a specific room matching the event. */
  expectEmittedTo(
    room: string,
    event: string,
    partialPayload?: Record<string, unknown>,
  ): void;
  /** Assert nothing was emitted for the given event. */
  expectNotEmitted(event: string): void;
  reset(): void;
}

/**
 * Creates a typed mock of the Socket.IO Server suitable for use with
 * PhaseManager.setServer() and similar injection points.
 *
 * All `server.to(room).emit(event, payload)` calls are recorded in `emits`.
 */
export function createMockSocketServer(): MockSocketServer {
  const emits: EmitRecord[] = [];

  const server = {
    to: jest.fn((room: string) => ({
      emit: jest.fn((event: string, payload: unknown) => {
        emits.push({ room, event, payload });
      }),
    })),
  };

  return {
    server,
    emits,
    expectEmitted(event, partialPayload?) {
      const matching = emits.filter((e) => e.event === event);
      expect(matching.length).toBeGreaterThan(0);
      if (partialPayload) {
        const found = matching.some((e) =>
          Object.entries(partialPayload).every(
            ([k, v]) => (e.payload as Record<string, unknown>)?.[k] === v,
          ),
        );
        expect(found).toBe(true);
      }
    },
    expectEmittedTo(room, event, partialPayload?) {
      const matching = emits.filter(
        (e) => e.room === room && e.event === event,
      );
      expect(matching.length).toBeGreaterThan(0);
      if (partialPayload) {
        const found = matching.some((e) =>
          Object.entries(partialPayload).every(
            ([k, v]) => (e.payload as Record<string, unknown>)?.[k] === v,
          ),
        );
        expect(found).toBe(true);
      }
    },
    expectNotEmitted(event) {
      const matching = emits.filter((e) => e.event === event);
      expect(matching.length).toBe(0);
    },
    reset() {
      emits.length = 0;
      server.to.mockClear();
    },
  };
}

/**
 * Creates a mock Socket.IO client socket for use in gateway handler tests.
 */
export function createMockSocket(id = 'socket-id'): {
  id: string;
  join: jest.Mock;
  emit: jest.Mock;
  data: Record<string, unknown>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    id,
    join: jest.fn(),
    emit: jest.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    data: {},
    emitted,
  };
}
