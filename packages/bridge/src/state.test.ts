import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeState, evictOldest, jsonStateFile } from "./state.js";

// The on-disk shapes below are pinned: a new version must read the previous
// version's files.

let dir: string;
let lines: string[];
const log = (...a: unknown[]) => lines.push(a.map(String).join(" "));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function files() {
  return {
    pauseFile: join(dir, "paused.json"),
    conversationEpochFile: join(dir, "conversation-epochs.json"),
    engagementFile: join(dir, "engaged-threads.json"),
  };
}
const boot = () => createBridgeState<{ text: string }>({ ...files(), log });
const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe("pause state file", () => {
  it("reads the file the previous version wrote", () => {
    writeFileSync(files().pauseFile, '{"active":true,"by":"maria"}', "utf8");
    const s = boot();
    expect(s.paused).toEqual({ active: true, by: "maria" });
    expect(lines.some((l) => l.includes("RESUMING PAUSED") && l.includes("maria"))).toBe(true);
  });

  it("writes byte-for-byte what the previous version wrote", () => {
    const s = boot();
    s.pause("maria");
    expect(read("paused.json")).toBe('{"active":true,"by":"maria"}');
    s.resume();
    expect(read("paused.json")).toBe('{"active":false}');
    expect(boot().paused.active).toBe(false);
  });

  it("junk or a missing file means running, silently", () => {
    expect(boot().paused.active).toBe(false);
    writeFileSync(files().pauseFile, "not json", "utf8");
    expect(boot().paused.active).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("engagement state file", () => {
  it("reads both shapes earlier builds wrote", () => {
    writeFileSync(
      files().engagementFile,
      JSON.stringify({ R1: ["a", "b"], R2: { ids: ["c"], owners: { c: "sam" } } }),
      "utf8",
    );
    const s = boot();
    expect([...s.roomFor("R1").engagedIds]).toEqual(["a", "b"]);
    expect(s.roomFor("R1").threadOwners.size).toBe(0);
    expect([...s.roomFor("R2").engagedIds]).toEqual(["c"]);
    expect(s.roomFor("R2").threadOwners.get("c")).toBe("sam");
    expect(lines).toContain(`restored engaged threads for 2 room(s) from ${files().engagementFile}`);
  });

  it("writes byte-for-byte what the previous version wrote, and reads it back", () => {
    const s = boot();
    s.roomFor("R1").engagedIds.add("a");
    s.roomFor("R1").engagedIds.add("b");
    s.roomFor("R1").threadOwners.set("b", "maria");
    s.roomFor("R2").engagedIds.add("c");
    s.roomFor("EMPTY");
    s.persistEngagement();
    expect(read("engaged-threads.json")).toBe(
      '{"R1":{"ids":["a","b"],"owners":{"b":"maria"}},"R2":{"ids":["c"]}}',
    );
    const again = boot();
    expect([...again.roomFor("R1").engagedIds]).toEqual(["a", "b"]);
    expect(again.roomFor("R1").threadOwners.get("b")).toBe("maria");
  });

  it("an invalid file logs the old line and starts empty", () => {
    writeFileSync(files().engagementFile, "{", "utf8");
    expect(boot().rooms.size).toBe(0);
    expect(lines.some((l) => l.startsWith(`engagement state file ${files().engagementFile} is not valid JSON:`))).toBe(true);
  });
});

describe("conversation epoch file", () => {
  it("reads the previous version's shape and writes it back unchanged", () => {
    const today = boot().conversationEpochs.epochFor("R");
    writeFileSync(files().conversationEpochFile, JSON.stringify({ R: { day: today, n: 2 } }), "utf8");
    const s = boot();
    expect(s.conversationEpochs.epochFor("R")).toBe(`${today}.2`);
    s.conversationEpochs.bump("R");
    expect(read("conversation-epochs.json")).toBe(`{"R":{"day":"${today}","n":3}}`);
  });
});

describe("jsonStateFile", () => {
  it("a failed write logs and does not throw", () => {
    const f = jsonStateFile<number>(join(dir, "missing-dir", "x.json"), { parse: Number, log, label: "x" });
    expect(() => f.persist(1)).not.toThrow();
    expect(lines[0]).toMatch(/^could not persist x to .*x\.json: /);
  });
});

describe("bounded state", () => {
  it("markConversationStarted keeps the newest 500, refreshing recency", () => {
    const s = boot();
    for (let i = 0; i < 501; i++) s.markConversationStarted(`c${i}`);
    expect(s.startedConversations.size).toBe(500);
    expect(s.startedConversations.has("c0")).toBe(false);
    s.markConversationStarted("c1");
    s.markConversationStarted("c501");
    expect(s.startedConversations.has("c1")).toBe(true);
    expect(s.startedConversations.has("c2")).toBe(false);
  });

  it("the thread-root cache holds 200 and never evicts the root just cached", () => {
    const s = boot();
    for (let i = 0; i < 201; i++) s.cacheThreadRoot(`t${i}`, null);
    expect(s.cachedThreadRoot("t0")).toBeUndefined();
    expect(s.cachedThreadRoot("t200")).toBeNull();
  });

  it("evictOldest never removes the kept key", () => {
    const keys = new Set(["only"]);
    evictOldest(keys, 0, "only");
    expect([...keys]).toEqual(["only"]);
  });
});
