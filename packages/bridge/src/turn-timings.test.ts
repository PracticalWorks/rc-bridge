import { describe, expect, it } from "vitest";
import { createTurnTimings, DEFAULT_TURN_TIMINGS_MAX, type TurnTiming } from "./turn-timings.js";

const turn = (n: number): TurnTiming => ({
  at: new Date(n * 1000).toISOString(),
  room: `R${n}`,
  status: "ok",
  firstEventMs: n,
  firstTextMs: n + 1,
  totalMs: n + 2,
  tools: 0,
});

describe("turn timings ring", () => {
  it("keeps only the last 20 turns, oldest first", () => {
    const ring = createTurnTimings();
    for (let n = 1; n <= 25; n++) ring.record(turn(n));
    const rooms = ring.list().map((t) => t.room);
    expect(DEFAULT_TURN_TIMINGS_MAX).toBe(20);
    expect(rooms).toHaveLength(20);
    expect(rooms[0]).toBe("R6");
    expect(rooms.at(-1)).toBe("R25");
  });

  it("hands out copies, so /health cannot change what was recorded", () => {
    const ring = createTurnTimings(2);
    ring.record(turn(1));
    ring.list()[0]!.totalMs = 999;
    expect(ring.list()[0]!.totalMs).toBe(3);
  });

  it("carries numbers and the room id only", () => {
    const ring = createTurnTimings();
    ring.record({ ...turn(1), firstEventMs: null, firstTextMs: null, profile: "default", status: "error" });
    expect(Object.keys(ring.list()[0]!).sort()).toEqual(
      ["at", "firstEventMs", "firstTextMs", "profile", "room", "status", "tools", "totalMs"],
    );
  });
});
