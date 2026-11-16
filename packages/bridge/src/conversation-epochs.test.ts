import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationEpochs, dailyEpoch, isResetCommand } from "./conversation-epochs.js";
import { conversationKey } from "./threading.js";

// Local-time constructor, because `dailyEpoch` rolls days over at a LOCAL
// hour — that is the point of it — and a UTC fixture would move the boundary
// with the machine's zone.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("dailyEpoch", () => {
  it("rolls the day over at 04:00 local, not midnight", () => {
    expect(dailyEpoch(at(2026, 9, 2, 3, 59))).toBe("2026-09-01");
    expect(dailyEpoch(at(2026, 9, 2, 4, 0))).toBe("2026-09-02");
    expect(dailyEpoch(at(2026, 9, 2, 23, 59))).toBe("2026-09-02");
  });

  it("keeps one whole evening-to-morning conversation on one epoch", () => {
    // 20:06 and 03:30 the next morning are the same day's conversation; the
    // boundary sits where nobody is mid-sentence.
    expect(dailyEpoch(at(2026, 9, 1, 20, 6))).toBe(dailyEpoch(at(2026, 9, 2, 3, 30)));
  });

  it("honours a different boundary hour", () => {
    expect(dailyEpoch(at(2026, 9, 2, 0, 30), 0)).toBe("2026-09-02");
  });

  it("rolls cleanly across a month and a year end", () => {
    expect(dailyEpoch(at(2026, 10, 1, 2, 0))).toBe("2026-09-30");
    expect(dailyEpoch(at(2027, 1, 1, 3, 59))).toBe("2026-12-31");
  });

  describe("across a DST transition", () => {
    // The boundary is promised on the wall clock. Subtracting four hours from
    // the instant is only the same thing while the UTC offset holds still, and
    // on the morning the clocks fall back it is not: 03:30 EST sits 4h30 after
    // the previous 04:00 EDT boundary by the instant, yet before 04:00 by the
    // clock, so it must stay in the previous day's epoch.
    const previousTz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = "America/New_York";
    });
    afterEach(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });

    it("keeps 03:30 EST after the fall-back in the previous epoch, and starts the new one at 04:00", () => {
      // Node re-reads TZ on assignment; prove the zone actually took, so a
      // runtime that ignored it fails here rather than passing vacuously.
      const fallBack = new Date("2026-11-01T08:30:00Z"); // 03:30 EST
      expect(fallBack.getTimezoneOffset()).toBe(300);
      expect(fallBack.getHours()).toBe(3);
      expect(dailyEpoch(fallBack)).toBe("2026-10-31");
      expect(dailyEpoch(new Date("2026-11-01T07:30:00Z"))).toBe("2026-10-31"); // 02:30 EST
      expect(dailyEpoch(new Date("2026-11-01T09:00:00Z"))).toBe("2026-11-01"); // 04:00 EST
    });

    it("does the same on the spring-forward morning", () => {
      expect(dailyEpoch(new Date("2026-03-08T07:30:00Z"))).toBe("2026-03-07"); // 03:30 EDT
      expect(dailyEpoch(new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08"); // 04:00 EDT
    });
  });
});

describe("isResetCommand", () => {
  it("accepts /new and /reset on their own, any case", () => {
    expect(isResetCommand("/new")).toBe(true);
    expect(isResetCommand("  /RESET ")).toBe(true);
  });

  it("accepts the command addressed to any of our faces", () => {
    expect(isResetCommand("@concierge /new")).toBe(true);
    expect(isResetCommand("/new @helper")).toBe(true);
    expect(isResetCommand("@help.desk /reset")).toBe(true);
  });

  it("treats anything else as prose for the agent", () => {
    expect(isResetCommand("/new plan for the week")).toBe(false);
    expect(isResetCommand("start a new conversation")).toBe(false);
    expect(isResetCommand("!bridge off")).toBe(false);
    expect(isResetCommand("")).toBe(false);
  });
});

describe("ConversationEpochs", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "epochs-"));
    file = join(dir, "conversation-epochs.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keys a room on the daily epoch until someone asks for a reset", () => {
    const epochs = new ConversationEpochs(file);
    const now = at(2026, 9, 2, 10);
    expect(epochs.epochFor("DM1", now)).toBe("2026-09-02");
    expect(epochs.epochFor("DM1", at(2026, 9, 3, 10))).toBe("2026-09-03");
  });

  it("bumps per room, counting within the day", () => {
    const epochs = new ConversationEpochs(file);
    const now = at(2026, 9, 2, 10);
    expect(epochs.bump("DM1", now)).toBe("2026-09-02.1");
    expect(epochs.bump("DM1", now)).toBe("2026-09-02.2");
    expect(epochs.epochFor("DM1", now)).toBe("2026-09-02.2");
    // Another room is untouched.
    expect(epochs.epochFor("DM2", now)).toBe("2026-09-02");
  });

  it("lets the daily boundary supersede yesterday's manual reset", () => {
    const epochs = new ConversationEpochs(file);
    epochs.bump("DM1", at(2026, 9, 2, 10));
    expect(epochs.epochFor("DM1", at(2026, 9, 3, 10))).toBe("2026-09-03");
    // …and a reset on the new day starts counting from 1 again.
    expect(epochs.bump("DM1", at(2026, 9, 3, 10))).toBe("2026-09-03.1");
  });

  it("survives a restart", () => {
    const first = new ConversationEpochs(file);
    first.bump("DM1", at(2026, 9, 2, 10));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ DM1: { day: "2026-09-02", n: 1 } });

    const second = new ConversationEpochs(file);
    expect(second.epochFor("DM1", at(2026, 9, 2, 12))).toBe("2026-09-02.1");
  });

  it("starts clean on a missing or unreadable state file", () => {
    const logged: string[] = [];
    expect(new ConversationEpochs(join(dir, "nope.json"), (l) => logged.push(l)).epochFor("DM1", at(2026, 9, 2, 10))).toBe(
      "2026-09-02",
    );
    expect(logged).toEqual([]);

    writeFileSync(file, "{not json", "utf8");
    const epochs = new ConversationEpochs(file, (l) => logged.push(l));
    expect(epochs.epochFor("DM1", at(2026, 9, 2, 10))).toBe("2026-09-02");
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("ignoring unreadable conversation epochs");
  });

  it("works with no file at all (in-memory only)", () => {
    const epochs = new ConversationEpochs(undefined);
    expect(epochs.bump("DM1", at(2026, 9, 2, 10))).toBe("2026-09-02.1");
  });
});

describe("conversationKey with an epoch", () => {
  it("bounds the top-level DM conversation by epoch", () => {
    expect(conversationKey("DM1", "msgA", true, undefined, "2026-09-02")).toBe("rc:DM1:2026-09-02");
    expect(conversationKey("DM1", "msgB", true, undefined, "2026-09-02")).toBe("rc:DM1:2026-09-02");
    expect(conversationKey("DM1", "msgC", true, undefined, "2026-09-03")).toBe("rc:DM1:2026-09-03");
    expect(conversationKey("DM1", "msgD", true, undefined, "2026-09-03.1")).toBe("rc:DM1:2026-09-03.1");
  });

  it("applies to the unthreaded channel fallback too", () => {
    expect(conversationKey("ROOM1", undefined, false, undefined, "2026-09-02")).toBe("rc:ROOM1:2026-09-02");
  });

  it("never touches a thread key", () => {
    expect(conversationKey("DM1", "topicA", true, "topicA", "2026-09-02")).toBe("rc:DM1:topicA");
    expect(conversationKey("ROOM1", "root1", false, "root1", "2026-09-02")).toBe("rc:ROOM1:root1");
    expect(conversationKey("ROOM1", "ownId", false, undefined, "2026-09-02")).toBe("rc:ROOM1:ownId");
  });

  it("is exactly the old key when no epoch is given", () => {
    expect(conversationKey("DM1", "msgA", true)).toBe("rc:DM1");
  });
});
