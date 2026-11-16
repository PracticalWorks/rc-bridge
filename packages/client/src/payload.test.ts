import { describe, expect, it } from "vitest";
import {
  fallbackCall,
  illegalPostKeys,
  illegalReactKeys,
  illegalSendMessageKeys,
  postCall,
  reactCall,
  roomIdOfCall,
} from "./payload.js";

describe("postCall", () => {
  it("uses plain chat.postMessage for a non-threaded reply", () => {
    expect(postCall("room1", "hi", undefined, true)).toEqual({
      endpoint: "chat.postMessage",
      body: { roomId: "room1", text: "hi" },
    });
  });

  it("uses chat.sendMessage when a threaded reply wants tshow", () => {
    expect(postCall("room1", "hi", "t1", true)).toEqual({
      endpoint: "chat.sendMessage",
      body: { message: { rid: "room1", msg: "hi", tmid: "t1", tshow: true } },
    });
  });

  it("keeps a threaded reply out of the parent channel when the feature is off", () => {
    expect(postCall("room1", "thread reply", "t1", false)).toEqual({
      endpoint: "chat.postMessage",
      body: { roomId: "room1", text: "thread reply", tmid: "t1" },
    });
  });

  it("keeps direct #all messages visible when the feature is off", () => {
    expect(postCall("all", "direct announcement", undefined, false)).toEqual({
      endpoint: "chat.postMessage",
      body: { roomId: "all", text: "direct announcement" },
    });
  });

  // Sending `tshow` to chat.postMessage 400s every reply with "must NOT have
  // additional properties", and nothing is posted.
  it("NEVER puts tshow on a chat.postMessage body, in any combination", () => {
    for (const tmid of [undefined, "t1"]) {
      for (const show of [true, false]) {
        const call = postCall("room1", "hi", tmid, show);
        if (call.endpoint === "chat.postMessage") {
          expect(call.body).not.toHaveProperty("tshow");
          expect(illegalPostKeys(call.body)).toEqual([]);
        }
      }
    }
  });

  it("never sends tshow:false — an explicit false is still an extra property", () => {
    // Otherwise turning threadShow off would break every threaded post.
    const off = postCall("room1", "hi", "t1", false);
    expect(JSON.stringify(off.body)).not.toContain("tshow");
  });

  it("only ever emits keys chat.postMessage actually accepts", () => {
    for (const tmid of [undefined, "t1"]) {
      const call = postCall("room1", "hi", tmid, false);
      expect(illegalPostKeys(call.body)).toEqual([]);
    }
  });
});

describe("fallbackCall", () => {
  it("is always plain chat.postMessage, so a reply can't be lost to a schema quibble", () => {
    expect(fallbackCall("room1", "hi", "t1")).toEqual({
      endpoint: "chat.postMessage",
      body: { roomId: "room1", text: "hi", tmid: "t1" },
    });
    expect(illegalPostKeys(fallbackCall("room1", "hi", "t1").body)).toEqual([]);
  });

  it("keeps the thread when falling back, so the reply still lands in place", () => {
    expect(fallbackCall("room1", "hi", "t1").body).toMatchObject({ tmid: "t1" });
    expect(fallbackCall("room1", "hi", undefined).body).not.toHaveProperty("tmid");
  });
});

describe("illegalPostKeys", () => {
  it("flags exactly what the real API would reject", () => {
    expect(illegalPostKeys({ roomId: "r", text: "t", tshow: true })).toEqual(["tshow"]);
    expect(illegalPostKeys({ roomId: "r", text: "t", tmid: "m" })).toEqual([]);
  });
});

describe("reactCall", () => {
  it("targets chat.react with exactly messageId, emoji and shouldReact", () => {
    const call = reactCall("MSG1", "eyes", true);
    expect(call.endpoint).toBe("chat.react");
    expect(call.body).toEqual({ messageId: "MSG1", emoji: "eyes", shouldReact: true });
    expect(illegalReactKeys(call.body)).toEqual([]);
  });

  it("always states shouldReact, so removing a receipt can never toggle it back on", () => {
    expect(reactCall("M", "eyes", false).body.shouldReact).toBe(false);
  });

  it("flags a key chat.react was never meant to carry", () => {
    expect(illegalReactKeys({ messageId: "m", emoji: "e", roomId: "r" })).toEqual(["roomId"]);
  });
});

describe("illegalSendMessageKeys", () => {
  it("accepts every chat.sendMessage body postCall builds, voice included", () => {
    const call = postCall("room1", "hi", "t1", true, { alias: "Helper", avatar: "https://example.com/a.png" });
    expect(call.endpoint).toBe("chat.sendMessage");
    expect(illegalSendMessageKeys(call.body)).toEqual([]);
  });

  it("flags a key the message object does not take", () => {
    expect(illegalSendMessageKeys({ message: { rid: "r", msg: "m", roomId: "r" } })).toEqual(["roomId"]);
  });
});

describe("voice fields", () => {
  it("puts a voice beside chat.postMessage's fields and inside chat.sendMessage's message", () => {
    expect(postCall("room1", "hi", undefined, true, { alias: "Helper" }).body).toEqual({ roomId: "room1", text: "hi", alias: "Helper" });
    expect(postCall("room1", "hi", "t1", true, { alias: "Helper" }).body).toEqual({
      message: { rid: "room1", msg: "hi", tmid: "t1", tshow: true, alias: "Helper" },
    });
  });

  it("never sends a blank alias or avatar", () => {
    expect(fallbackCall("room1", "hi", undefined, { alias: "", avatar: "" }).body).toEqual({ roomId: "room1", text: "hi" });
  });
});

describe("roomIdOfCall", () => {
  it("finds the room in either post shape, and none in a reaction", () => {
    expect(roomIdOfCall(postCall("room1", "hi", undefined, false).body)).toBe("room1");
    expect(roomIdOfCall(postCall("room1", "hi", "t1", true).body)).toBe("room1");
    expect(roomIdOfCall(reactCall("m", "eyes", true).body)).toBeUndefined();
  });
});
