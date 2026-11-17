import { describe, expect, it } from "vitest";
import { extractReactions, receiptTransition, shortcodeFor } from "./reactions.js";

describe("shortcodeFor", () => {
  it("names the emoji the agent writes as the character, :name:, or a bare name", () => {
    expect(shortcodeFor("👍")).toBe("thumbsup");
    expect(shortcodeFor(":tada:")).toBe("tada");
    expect(shortcodeFor("heart")).toBe("heart");
  });

  it("treats a variation selector as the same emoji", () => {
    expect(shortcodeFor("❤️")).toBe("heart");
    expect(shortcodeFor("⚠")).toBe("warning");
  });

  it("refuses anything off the map — RC would 400 it", () => {
    expect(shortcodeFor("🦖")).toBeUndefined();
    expect(shortcodeFor(":not_an_emoji:")).toBeUndefined();
  });
});

describe("extractReactions", () => {
  it("leaves a reply with no marker untouched", () => {
    expect(extractReactions("Filed it as issue 4.")).toEqual({ text: "Filed it as issue 4.", emoji: [], unknown: [] });
  });

  it("turns a reaction-only reply into no text and one reaction", () => {
    expect(extractReactions("[react: 👍]")).toEqual({ text: "", emoji: ["thumbsup"], unknown: [] });
  });

  it("strips the marker wherever the model put it", () => {
    expect(extractReactions("Booked it. [react: 🎉]").text).toBe("Booked it.");
    expect(extractReactions("[REACT: :tada:]\nBooked it.").text).toBe("Booked it.");
  });

  it("reads several emoji, joined or spaced, and dedupes them", () => {
    expect(extractReactions("[react: 👍🎉] [react: 👍, :fire:]").emoji).toEqual(["thumbsup", "tada", "fire"]);
  });

  it("reports what it could not name instead of sending it", () => {
    const r = extractReactions("[react: 🦖 👍]");
    expect(r.emoji).toEqual(["thumbsup"]);
    expect(r.unknown).toEqual(["🦖"]);
  });
});

describe("receiptTransition", () => {
  it("puts 👀 on a message that has no receipt yet", () => {
    expect(receiptTransition(undefined, "seen")).toEqual([{ emoji: "eyes", shouldReact: true }]);
  });

  it("swaps 👀 for ✅, removal first", () => {
    expect(receiptTransition("seen", "done")).toEqual([
      { emoji: "eyes", shouldReact: false },
      { emoji: "white_check_mark", shouldReact: true },
    ]);
  });

  it("only takes 👀 off when the turn settles without a receipt of its own", () => {
    expect(receiptTransition("seen", undefined)).toEqual([{ emoji: "eyes", shouldReact: false }]);
  });

  it("does nothing when the state does not change", () => {
    expect(receiptTransition("seen", "seen")).toEqual([]);
    expect(receiptTransition(undefined, undefined)).toEqual([]);
  });
});
