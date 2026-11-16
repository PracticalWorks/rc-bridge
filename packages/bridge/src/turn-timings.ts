// Where a turn's time went, for /health. Room id and numbers only — never message
// text or prompts. Bounded: it is a debugging aid, not a log.

export interface TurnTiming {
  at: string;
  room: string;
  profile?: string;
  status: "ok" | "error";
  /** ms from the agent request to its first stream event; null when none (non-streaming). */
  firstEventMs: number | null;
  /** ms from the agent request to its first text delta; null when none. */
  firstTextMs: number | null;
  totalMs: number;
  tools: number;
}

export const DEFAULT_TURN_TIMINGS_MAX = 20;

export interface TurnTimings {
  record(entry: TurnTiming): void;
  /** Oldest first, newest last. A copy: callers cannot mutate the ring. */
  list(): TurnTiming[];
}

export function createTurnTimings(max = DEFAULT_TURN_TIMINGS_MAX): TurnTimings {
  const ring: TurnTiming[] = [];
  return {
    record(entry) {
      ring.push(entry);
      while (ring.length > max) ring.shift();
    },
    list: () => ring.map((t) => ({ ...t })),
  };
}
