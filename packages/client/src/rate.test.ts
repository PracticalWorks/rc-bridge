import { describe, expect, it } from "vitest";
import * as rate from "./rate.js";
import { DEFAULT_LOOP_WINDOW_MS, DEFAULT_MAX_POSTS_PER_THREAD, MAX_RATE_KEYS, withinRate } from "./rate.js";

describe("withinRate — the loop backstop", () => {
  it("allows up to the limit, then refuses", () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) expect(withinRate(seen, "t1", 1000 + i, 3, 60_000)).toBe(true);
    expect(withinRate(seen, "t1", 1004, 3, 60_000)).toBe(false);
  });

  it("recovers once the window passes", () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) withinRate(seen, "t1", 1000, 3, 60_000);
    expect(withinRate(seen, "t1", 1000, 3, 60_000)).toBe(false);
    expect(withinRate(seen, "t1", 62_000, 3, 60_000)).toBe(true);
  });

  it("counts threads independently — one loop can't mute another room", () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) withinRate(seen, "busy", 1000, 3, 60_000);
    expect(withinRate(seen, "busy", 1000, 3, 60_000)).toBe(false);
    expect(withinRate(seen, "quiet", 1000, 3, 60_000)).toBe(true);
  });

  it("bounds its own bookkeeping", () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < 500; i++) withinRate(seen, `k${i}`, i, 3, 60_000);
    expect(seen.size).toBeLessThanOrEqual(MAX_RATE_KEYS + 1);
  });

  // There is one ceiling, and it counts what the client EMITS. A cap on how long
  // a person may talk could only ever fire on a person.
  it("bounds what the client emits, and nothing about how long a human may talk", () => {
    expect(DEFAULT_LOOP_WINDOW_MS).toBe(10 * 60_000);
    expect(DEFAULT_MAX_POSTS_PER_THREAD).toBe(40);
    expect(Object.keys(rate)).not.toContain("DEFAULT_MAX_TURNS_PER_THREAD");
  });

  it("still stops a runaway, at the real default", () => {
    const seen = new Map<string, number[]>();
    const now = 1_000;
    for (let i = 0; i < DEFAULT_MAX_POSTS_PER_THREAD; i++) {
      expect(withinRate(seen, "thread", now + i, DEFAULT_MAX_POSTS_PER_THREAD, DEFAULT_LOOP_WINDOW_MS)).toBe(true);
    }
    // Spend is still bounded inside a window.
    expect(withinRate(seen, "thread", now + 999, DEFAULT_MAX_POSTS_PER_THREAD, DEFAULT_LOOP_WINDOW_MS)).toBe(false);
  });
});
