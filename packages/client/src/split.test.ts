import { describe, expect, it } from "vitest";
import { splitForRc, RC_MAX_MESSAGE_CHARS, RC_MAX_PARTS } from "./split.js";

describe("splitForRc", () => {
  it("leaves an ordinary reply completely untouched", () => {
    // The common case by orders of magnitude. This must not reshape it.
    const text = "Opened the report and started the import. I'll post the results here.";
    expect(splitForRc(text)).toEqual([text]);
  });

  it("leaves a reply exactly at the limit alone", () => {
    const text = "x".repeat(RC_MAX_MESSAGE_CHARS);
    expect(splitForRc(text)).toEqual([text]);
  });

  it("splits a reply over the limit instead of dropping it", () => {
    // Unsplit, Rocket.Chat answers 400 error-message-size-exceeded and posts
    // nothing.
    const parts = splitForRc([...Array(400)].map((_, i) => `line ${i} of the answer`).join("\n"));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(RC_MAX_MESSAGE_CHARS);
  });

  it("loses no content when it splits", () => {
    const lines = [...Array(400)].map((_, i) => `line ${i}`);
    const parts = splitForRc(lines.join("\n"));
    const rejoined = parts.join("\n");
    for (const line of lines) expect(rejoined).toContain(line);
  });

  it("splits on line boundaries, not mid-word", () => {
    // Every line in a part should be a WHOLE original line — that's what "line
    // boundary" actually means, and it's what keeps a split readable.
    const lines = [...Array(300)].map((_, i) => `sentence number ${i} goes here`);
    const parts = splitForRc(lines.join("\n"));
    const originals = new Set(lines);
    for (const part of parts) {
      for (const line of part.split("\n")) expect(originals.has(line)).toBe(true);
    }
  });

  it("hard-splits a single enormous line with no newlines", () => {
    const parts = splitForRc("z".repeat(RC_MAX_MESSAGE_CHARS * 3));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(RC_MAX_MESSAGE_CHARS);
  });

  it("closes and reopens a code fence across the split", () => {
    // Splitting a log dump mid-fence would render the rest of the room as one
    // giant code block.
    const body = [...Array(400)].map((_, i) => `2026-07-27 log line ${i}`).join("\n");
    const parts = splitForRc("Here are the logs:\n```\n" + body + "\n```");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const fences = (p.match(/^\s*```/gm) ?? []).length;
      expect(fences % 2).toBe(0); // every part is balanced on its own
    }
  });

  it("bounds how many messages one reply can become", () => {
    const parts = splitForRc("y".repeat(RC_MAX_MESSAGE_CHARS * 50));
    expect(parts.length).toBe(RC_MAX_PARTS);
    expect(parts[parts.length - 1]).toContain("truncated");
  });

  it("says so when it truncates, rather than silently stopping", () => {
    const parts = splitForRc("y".repeat(RC_MAX_MESSAGE_CHARS * 50), RC_MAX_MESSAGE_CHARS, 2);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/truncated/i);
  });

  it("handles an empty reply without producing junk", () => {
    expect(splitForRc("")).toEqual([""]);
  });

  // The truncation notice must not push the last part past the ceiling it
  // exists to keep.
  it("keeps a truncated reply's last part inside the ceiling, fence closed", () => {
    const fenced = "```\n" + [...Array(3000)].map((_, i) => `log line ${i}`).join("\n") + "\n```";
    for (const text of ["z".repeat(RC_MAX_MESSAGE_CHARS * 6), fenced]) {
      for (const part of splitForRc(text)) expect(part.length).toBeLessThanOrEqual(RC_MAX_MESSAGE_CHARS);
    }
    expect(splitForRc(fenced).at(-1)).toMatch(/\n```\n\n_\[truncated/);
  });
});
