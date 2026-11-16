import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_TTL_MS,
  holdFollowUp,
  takeFollowUp,
  type HeldFollowUp,
} from "./followups.js";

const store = () => new Map<string, HeldFollowUp<string>>();

describe("holdFollowUp / takeFollowUp — a message sent mid-turn is not lost", () => {
  it("gives back the message once the turn it collided with is done", () => {
    const held = store();
    holdFollowUp(held, "rc:room:T1", "and the PR link?", 1_000);
    expect(takeFollowUp(held, "rc:room:T1", 2_000)).toBe("and the PR link?");
  });

  it("takes it exactly once — a held message must not run twice", () => {
    const held = store();
    holdFollowUp(held, "rc:room:T1", "hello", 1_000);
    expect(takeFollowUp(held, "rc:room:T1", 2_000)).toBe("hello");
    expect(takeFollowUp(held, "rc:room:T1", 2_000)).toBeUndefined();
  });

  it("has nothing to give when nothing was held", () => {
    expect(takeFollowUp(store(), "rc:room:T1", 1_000)).toBeUndefined();
  });

  it("keeps the LATEST, and says that it replaced one", () => {
    const held = store();
    expect(holdFollowUp(held, "rc:room:T1", "wait", 1_000).replaced).toBe(false);
    expect(holdFollowUp(held, "rc:room:T1", "actually, the PR link", 1_100).replaced).toBe(true);
    // The correction, not the thing it corrected.
    expect(takeFollowUp(held, "rc:room:T1", 2_000)).toBe("actually, the PR link");
  });

  it("holds separately per conversation, so one thread never eats another's", () => {
    const held = store();
    holdFollowUp(held, "rc:room:T1", "for T1", 1_000);
    holdFollowUp(held, "rc:room:T2", "for T2", 1_000);
    expect(takeFollowUp(held, "rc:room:T1", 1_500)).toBe("for T1");
    expect(takeFollowUp(held, "rc:room:T2", 1_500)).toBe("for T2");
  });

  it("drops one that outlived its turn rather than replaying it late", () => {
    const held = store();
    holdFollowUp(held, "rc:room:T1", "stale", 1_000);
    expect(takeFollowUp(held, "rc:room:T1", 1_000 + FOLLOWUP_TTL_MS + 1)).toBeUndefined();
  });

  it("still forgets an expired hold, so an abandoned conversation can't pin memory", () => {
    const held = store();
    holdFollowUp(held, "rc:room:T1", "stale", 1_000);
    takeFollowUp(held, "rc:room:T1", 1_000 + FOLLOWUP_TTL_MS + 1);
    expect(held.size).toBe(0);
  });

  it("is bounded, and never evicts the hold it was just asked to keep", () => {
    const held = store();
    for (let i = 0; i < 5; i++) holdFollowUp(held, `rc:room:T${i}`, `m${i}`, 1_000 + i, 3);
    expect(held.size).toBe(3);
    // The newest survived; the oldest went first.
    expect(takeFollowUp(held, "rc:room:T4", 2_000)).toBe("m4");
    expect(takeFollowUp(held, "rc:room:T0", 2_000)).toBeUndefined();
  });
});
