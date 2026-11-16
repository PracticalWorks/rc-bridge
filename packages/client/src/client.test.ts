import { describe, expect, it } from "vitest";
import {
  DeadlineError,
  isDirectTarget,
  normalizeChannel,
  normalizeTargets,
  RC_MAX_MESSAGE_CHARS,
  RocketChatApiError,
  RocketChatClient,
  splitForRc,
} from "./index.js";

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

/** Records every request and answers with a representative Rocket.Chat shape. */
function makeFetch(calls: Call[], response: { ok?: boolean; status?: number; json?: unknown; text?: string } = {}) {
  return (async (url: string, init?: any) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json ?? { success: true, message: { _id: "msg_1" } },
      text: async () => response.text ?? "",
    };
  }) as unknown as typeof fetch;
}

const CONFIG = { baseUrl: "https://chat.test", userId: "u1", authToken: "t1" };

describe("target normalization", () => {
  it("treats '#General', 'general', and ' general ' as one channel", () => {
    expect(normalizeChannel("#General")).toBe("general");
    expect(normalizeChannel("general")).toBe("general");
    expect(normalizeChannel("  general  ")).toBe("general");
  });

  // The '@' must SURVIVE normalization — it is what routes a DM instead of a
  // channel post, and dropping it would silently redirect a private nudge into a
  // public room.
  it("preserves the '@' that makes a target a DM", () => {
    expect(normalizeChannel("@Sam")).toBe("@sam");
    expect(isDirectTarget("@sam")).toBe(true);
    expect(isDirectTarget("#general")).toBe(false);
    expect(isDirectTarget("general")).toBe(false);
  });
});

describe("normalizeTargets", () => {
  it("normalizes each entry into the comparison set", () => {
    const allowed = normalizeTargets(["#general", " Marketing ", "support"]);
    expect([...allowed].sort()).toEqual(["general", "marketing", "support"]);
  });

  it("allows DM targets alongside channels", () => {
    const allowed = normalizeTargets(["#general", "@Sam"]);
    expect(allowed.has("general")).toBe(true);
    expect(allowed.has("@sam")).toBe(true);
    // A person is not reachable just because a same-named channel is allowed.
    expect(allowed.has("sam")).toBe(false);
  });

  // An empty list must mean "announcing is OFF", never "any channel is fine".
  // An unattended scheduled job is the usual caller.
  it("yields an EMPTY set for an empty or blank list, so callers fail closed", () => {
    expect(normalizeTargets([]).size).toBe(0);
    expect(normalizeTargets([""]).size).toBe(0);
    expect(normalizeTargets(["  ", ""]).size).toBe(0);
  });
});

describe("RocketChatClient.authStatus", () => {
  it("probes /api/v1/me and returns the HTTP verdict without exposing credentials", async () => {
    const calls: Call[] = [];
    const status = await new RocketChatClient(CONFIG, makeFetch(calls, { ok: false, status: 401 })).authStatus();
    expect(status).toEqual({ ok: false, status: 401, error: "Rocket.Chat /api/v1/me answered 401" });
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/me");
    expect(calls[0]?.headers).toEqual({ "X-Auth-Token": "t1", "X-User-Id": "u1" });
  });
});
describe("RocketChatClient.postToChannel", () => {
  it("posts to chat.postMessage with the bot headers and a '#'-prefixed channel", async () => {
    const calls: Call[] = [];
    const posted = await new RocketChatClient(CONFIG, makeFetch(calls)).postToChannel("general", "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://chat.test/api/v1/chat.postMessage");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers?.["X-Auth-Token"]).toBe("t1");
    expect(calls[0].headers?.["X-User-Id"]).toBe("u1");
    expect(calls[0].body).toEqual({ channel: "#general", text: "hello" });
    expect(posted.messageId).toBe("msg_1");
  });

  it("does not double-prefix a channel already written as '#general'", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToChannel("#general", "hello");
    expect(calls[0].body.channel).toBe("#general");
  });

  // RC opens the DM room itself for an '@name' target, which is how an unattended
  // run reaches someone who is not watching a channel.
  it("sends an '@name' target as a DM, not a channel post", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToChannel("@sam", "ping");
    expect(calls[0].body.channel).toBe("@sam");
  });

  it("trims a trailing slash off the base url", async () => {
    const calls: Call[] = [];
    await new RocketChatClient({ ...CONFIG, baseUrl: "https://chat.test/" }, makeFetch(calls)).postToChannel("x", "y");
    expect(calls[0].url).toBe("https://chat.test/api/v1/chat.postMessage");
  });

  it("throws on a non-OK response instead of losing the message silently", async () => {
    const client = new RocketChatClient(CONFIG, makeFetch([], { ok: false, status: 401, text: "unauthorized" }));
    await expect(client.postToChannel("general", "hi")).rejects.toThrow(/401/);
  });

  // Rocket.Chat answers 200 with `success: false` when the bot cannot see the
  // channel, so the status code alone is not proof of delivery.
  it("throws when RC returns 200 but success:false", async () => {
    const client = new RocketChatClient(
      CONFIG,
      makeFetch([], { json: { success: false, error: "room not found" } }),
    );
    await expect(client.postToChannel("nope", "hi")).rejects.toThrow(/room not found/);
  });
});

describe("RocketChatClient.postToRoom", () => {
  // The whole reason this method exists: `channel` addresses a room by NAME, and a
  // thread has no name — only `roomId` + `tmid` reaches inside one.
  it("posts into a thread with roomId and tmid, never a channel name", async () => {
    const calls: Call[] = [];
    const posted = await new RocketChatClient(CONFIG, makeFetch(calls)).postToRoom("R1", "Reminder: review code.", "T1");

    expect(calls[0].url).toBe("https://chat.test/api/v1/chat.postMessage");
    expect(calls[0].headers?.["X-Auth-Token"]).toBe("t1");
    expect(calls[0].body).toEqual({ roomId: "R1", text: "Reminder: review code.", tmid: "T1" });
    expect(calls[0].body.channel).toBeUndefined();
    expect(posted.messageId).toBe("msg_1");
  });

  // `tmid: undefined` is not the same as no tmid: RC rejects a null thread id, and a
  // test double permissive enough to accept it would pass while the real API 400s.
  it("omits tmid entirely when there is no thread, rather than sending undefined", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToRoom("R1", "hello");
    expect(calls[0].body).toEqual({ roomId: "R1", text: "hello" });
    expect("tmid" in calls[0].body).toBe(false);
  });

  // A scheduled run has no human watching, so the failure has to leave the tool as an
  // error. Silence here is how a reminder gets lost twice.
  it("names the room and thread when RC refuses the post", async () => {
    const client = new RocketChatClient(CONFIG, makeFetch([], { json: { success: false, error: "not-allowed" } }));
    await expect(client.postToRoom("R1", "hi", "T1")).rejects.toThrow(/room R1 \(thread T1\).*not-allowed/s);
  });

  it("throws on a non-OK response instead of losing the reminder silently", async () => {
    const client = new RocketChatClient(CONFIG, makeFetch([], { ok: false, status: 403, text: "forbidden" }));
    await expect(client.postToRoom("R1", "hi", "T1")).rejects.toThrow(/403/);
  });
});

// A Rocket.Chat DISCUSSION does not answer to the name a human knows it by. Its
// `name` is generated (here `Xq7RfLm2Pz9KdWnTb`) and the title everyone reads,
// `harbor`, is only its `fname`. `chat.postMessage` resolves `channel` against
// `name`, so a post to a discussion by its title fails with `[invalid-channel]`
// while the room sits there in plain sight.
describe("a discussion is reached by its display name", () => {
  /** RC as it actually behaves: `#name` resolves, `#fname` does not. */
  function rcWithDiscussion(opts: { rooms: { _id: string; name: string; fname: string }[] }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });

      if (url.endsWith("/api/v1/rooms.get")) {
        return { ok: true, status: 200, json: async () => ({ update: opts.rooms }), text: async () => "" };
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.roomId) {
        return {
          ok: true, status: 200, text: async () => "",
          json: async () => ({ success: true, message: { _id: "msg_room", rid: body.roomId } }),
        };
      }
      const known = opts.rooms.some((r) => `#${r.name}` === body.channel);
      if (!known) {
        return {
          ok: false, status: 400,
          text: async () => '{"success":false,"error":"[invalid-channel]"}',
          json: async () => ({ success: false, error: "[invalid-channel]" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, message: { _id: "msg_name" } }), text: async () => "" };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const HARBOR = { _id: "64b0f00d0000000000000001", name: "Xq7RfLm2Pz9KdWnTb", fname: "harbor" };

  it("falls back to the room id when the name does not resolve", async () => {
    const { calls, fetchImpl } = rcWithDiscussion({ rooms: [HARBOR] });
    const posted = await new RocketChatClient(CONFIG, fetchImpl).postToChannel("harbor", "hi");

    expect(posted.roomId).toBe(HARBOR._id);
    // It tried the name first — the cheap path stays the normal one.
    expect(calls[0]?.body?.channel).toBe("#harbor");
    expect(calls[1]?.url).toContain("rooms.get");
    expect(calls[2]?.body?.roomId).toBe(HARBOR._id);
  });

  // The generated name is mixed case and every target is lower-cased three times
  // before it gets here, so matching has to be case-insensitive on fname.
  it("matches a display name regardless of case", async () => {
    const { fetchImpl } = rcWithDiscussion({
      rooms: [{ _id: "r_9", name: "aB3xYz", fname: "Harbor" }],
    });
    const posted = await new RocketChatClient(CONFIG, fetchImpl).postToChannel("#HARBOR", "hi");
    expect(posted.roomId).toBe("r_9");
  });

  // The whole point of the cheap path: a room whose name DOES resolve must never
  // pay for a rooms.get.
  it("does not look anything up when the name resolves", async () => {
    const { calls, fetchImpl } = rcWithDiscussion({
      rooms: [{ _id: "r_1", name: "lobby", fname: "lobby" }],
    });
    await new RocketChatClient(CONFIG, fetchImpl).postToChannel("lobby", "hi");
    expect(calls.filter((c) => c.url.includes("rooms.get"))).toHaveLength(0);
  });

  // A message in the wrong room cannot be taken back, so
  // an ambiguous display name refuses rather than picking the first hit.
  it("refuses to guess when two rooms share a display name", async () => {
    const { fetchImpl } = rcWithDiscussion({
      rooms: [
        { _id: "r_a", name: "genA", fname: "harbor" },
        { _id: "r_b", name: "genB", fname: "harbor" },
      ],
    });
    await expect(new RocketChatClient(CONFIG, fetchImpl).postToChannel("harbor", "hi")).rejects.toThrow(
      /2 rooms displayed as "harbor"/,
    );
  });

  // rooms.get only sees rooms the bot has JOINED. If it is not a member, the
  // useful error is the original one — "not a member" is what needs fixing, not
  // the lookup.
  it("reports the original failure when no room matches", async () => {
    const { fetchImpl } = rcWithDiscussion({ rooms: [] });
    await expect(new RocketChatClient(CONFIG, fetchImpl).postToChannel("harbor", "hi")).rejects.toThrow(
      /invalid-channel/,
    );
  });

  // A DM has no display name, and an unknown @person is a real error. Retrying it
  // as a room lookup would replace a reportable failure with a confusing one.
  it("never turns a failed DM into a room lookup", async () => {
    const { calls, fetchImpl } = rcWithDiscussion({ rooms: [] });
    await expect(new RocketChatClient(CONFIG, fetchImpl).postToChannel("@nobody", "hi")).rejects.toThrow();
    expect(calls.filter((c) => c.url.includes("rooms.get"))).toHaveLength(0);
  });
});

// The fallback above may only fire on a room Rocket.Chat itself said it could not
// find. Reading `[invalid-channel]` out of the RENDERED error message, which embeds
// up to 300 characters of server-controlled body, would let a 401, a 403, or a
// proxy's HTML outage page that merely QUOTED the token be retried as a room
// lookup, and once the id resolved the message would go out anyway.
describe("only a room-not-found is retried as a display-name lookup", () => {
  const ROOM = { _id: "r_ops", name: "Xq7RfLm2Pz9KdWnTb", fname: "harbor" };

  /**
   * RC where the post BY NAME fails however the test says, but `rooms.get` and a
   * post BY ID both succeed. That asymmetry is the point: if the guard leaks, the
   * lookup runs to completion and delivers, so a leak shows up as a message that
   * went out behind a failure that should have stopped it — not as a silent retry.
   */
  function rcFailingNamePost(
    namePost: () => Promise<any>,
    rooms: { _id: string; name: string; fname: string }[] = [ROOM],
  ) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });

      if (url.endsWith("/api/v1/rooms.get")) {
        return { ok: true, status: 200, json: async () => ({ update: rooms }), text: async () => "" };
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.roomId) {
        return {
          ok: true, status: 200, text: async () => "",
          json: async () => ({ success: true, message: { _id: "msg_room", rid: body.roomId } }),
        };
      }
      return namePost();
    }) as unknown as typeof fetch;
    return { calls, fetchImpl, lookups: () => calls.filter((c) => c.url.includes("rooms.get")) };
  }

  const post = (fetchImpl: typeof fetch) =>
    new RocketChatClient(CONFIG, fetchImpl).postToChannel("harbor", "hi");

  it("does not retry a 401 whose body quotes [invalid-channel]", async () => {
    const { fetchImpl, lookups } = rcFailingNamePost(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"success":false,"error":"[invalid-channel]"}',
    }));
    await expect(post(fetchImpl)).rejects.toThrow(/failed: 401/);
    expect(lookups()).toHaveLength(0);
  });

  it("does not retry a transport error whose message quotes error-room-not-found", async () => {
    const { fetchImpl, lookups } = rcFailingNamePost(async () => {
      throw new Error("request timed out: error-room-not-found");
    });
    await expect(post(fetchImpl)).rejects.toThrow(/request timed out/);
    expect(lookups()).toHaveLength(0);
  });

  // The body is echoed into the message verbatim, so anything that can put the token
  // in front of the guard must not satisfy it. An outage page is the easiest one.
  it("does not retry a 502 HTML error page that mentions invalid-channel", async () => {
    const { fetchImpl, lookups } = rcFailingNamePost(async () => ({
      ok: false,
      status: 502,
      text: async () => "<html><body>upstream error: invalid-channel</body></html>",
    }));
    await expect(post(fetchImpl)).rejects.toThrow(/failed: 502/);
    expect(lookups()).toHaveLength(0);
  });

  // The sharpest cost of a leaky guard is not the wasted round trip: it is that the
  // LOOKUP's error replaces the real one, and an operator is told to rename a room
  // when what actually broke is the credential.
  it("reports the 401, not an ambiguous-room error, when two rooms share the display name", async () => {
    const { fetchImpl } = rcFailingNamePost(
      async () => ({ ok: false, status: 401, text: async () => '{"error":"[invalid-channel]"}' }),
      [
        { _id: "r_a", name: "genA", fname: "harbor" },
        { _id: "r_b", name: "genB", fname: "harbor" },
      ],
    );
    await expect(post(fetchImpl)).rejects.toThrow(/failed: 401/);
  });

  // Tightening the guard must not cost RC's OTHER error shape: a 200 whose payload
  // carries `errorType`, which is how the typed routes name a missing room.
  it("still falls back on a 200 payload whose errorType is error-room-not-found", async () => {
    const { fetchImpl, lookups } = rcFailingNamePost(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ success: false, error: "no such channel", errorType: "error-room-not-found" }),
    }));
    await expect(post(fetchImpl)).resolves.toMatchObject({ roomId: ROOM._id });
    expect(lookups()).toHaveLength(1);
  });
});

// RC refuses a post over `Message_MaxAllowedSize` with 400
// `error-message-size-exceeded` and posts none of it, so a long text goes as
// ordered parts instead.
describe("an oversized post is split, never refused", () => {
  const long = [...Array(600)].map((_, i) => `line ${i} of the digest`).join("\n");

  it("posts a DM in parts: the first by name, the rest to the room it resolved", async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetch(calls, { json: { success: true, message: { _id: "m", rid: "dm_room" } } });
    const posted = await new RocketChatClient(CONFIG, fetchImpl).postToChannel("@sam", long);
    const parts = splitForRc(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(parts.length);
    expect(calls[0]!.body).toEqual({ channel: "@sam", text: parts[0] });
    expect(calls.slice(1).map((c) => c.body)).toEqual(parts.slice(1).map((text) => ({ roomId: "dm_room", text })));
    for (const c of calls) expect(c.body.text.length).toBeLessThanOrEqual(RC_MAX_MESSAGE_CHARS);
    expect(posted).toMatchObject({ channel: "@sam", roomId: "dm_room" });
    // Nothing dropped: the parts carry every line, in order.
    expect(calls.map((c) => c.body.text).join("\n")).toBe(long);
  });

  it("keeps every part of a threaded post inside the thread", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToRoom("room_1", long, "thread_1");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.body).toMatchObject({ roomId: "room_1", tmid: "thread_1" });
  });

  it("leaves a post that fits as one call, untouched", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToChannel("general", "short");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toBe("short");
  });

  // The truncation notice must fit inside the ceiling it exists to keep, fenced
  // or not.
  it("keeps a truncated text's last part inside the ceiling", () => {
    const fenced = "```\n" + [...Array(3000)].map((_, i) => `log line ${i}`).join("\n") + "\n```";
    for (const text of ["x".repeat(20_000), fenced]) {
      const parts = splitForRc(text);
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(RC_MAX_MESSAGE_CHARS);
      expect(parts.at(-1)).toMatch(/truncated/);
    }
    expect(splitForRc(fenced).at(-1)).toMatch(/\n```\n\n_\[truncated/);
  });
});

describe("RocketChatClient.botUserId / getMessage / voice / react", () => {
  it("exposes the configured user id as botUserId", () => {
    expect(new RocketChatClient(CONFIG).botUserId).toBe("u1");
  });

  it("reads a message by id", async () => {
    const calls: Call[] = [];
    const msg = {
      _id: "m1",
      rid: "r1",
      msg: "approve",
      ts: "2026-01-01T00:00:00.000Z",
      u: { _id: "u2", username: "riley" },
    };
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, method: init?.method, headers: init?.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: msg }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    const got = await new RocketChatClient(CONFIG, fetchImpl).getMessage("m1");
    expect(got).toEqual(msg);
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/chat.getMessage?msgId=m1");
    expect(calls[0]?.headers).toEqual({ "X-Auth-Token": "t1", "X-User-Id": "u1" });
  });

  it("returns null when RC says the message is missing (400/404)", async () => {
    const missing = (status: number) =>
      (async () => ({
        ok: false,
        status,
        json: async () => ({}),
        text: async () => '{"error":"error-message-not-found"}',
      })) as unknown as typeof fetch;
    expect(await new RocketChatClient(CONFIG, missing(400)).getMessage("nope")).toBeNull();
    expect(await new RocketChatClient(CONFIG, missing(404)).getMessage("nope")).toBeNull();
  });

  it("throws a typed API error on other getMessage failures", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":"unauthorized"}',
    })) as unknown as typeof fetch;
    await expect(new RocketChatClient(CONFIG, fetchImpl).getMessage("m1")).rejects.toBeInstanceOf(
      RocketChatApiError,
    );
  });

  it("posts with optional alias/avatar when a product supplies a voice", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).postToChannel("general", "hi", {
      alias: "Release Notes",
      avatar: "https://example/avatar.png",
    });
    expect(calls[0]?.body).toEqual({
      channel: "#general",
      text: "hi",
      alias: "Release Notes",
      avatar: "https://example/avatar.png",
    });
  });

  it("reacts via chat.react and swallows a soft failure", async () => {
    const calls: Call[] = [];
    await new RocketChatClient(CONFIG, makeFetch(calls)).react("m1", ":thumbsup:", true);
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/chat.react");
    expect(calls[0]?.body).toEqual({ messageId: "m1", emoji: ":thumbsup:", shouldReact: true });

    const failing = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    })) as unknown as typeof fetch;
    await expect(new RocketChatClient(CONFIG, failing).react("m1", ":x:")).resolves.toBeUndefined();
  });

  it("posts as a member via chat.sendMessage", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: { _id: "m2", rid: "R1" } }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    const posted = await new RocketChatClient(CONFIG, fetchImpl).postAsMember("R1", "reply", {
      tmid: "T1",
      voice: { alias: "Bot" },
    });
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/chat.sendMessage");
    expect(calls[0]?.body).toEqual({ message: { rid: "R1", msg: "reply", tmid: "T1", alias: "Bot" } });
    expect(posted).toEqual({ messageId: "m2", channel: "R1", roomId: "R1" });
  });

  it("joins then falls back to chat.postMessage when sendMessage is not-allowed", async () => {
    const calls: Call[] = [];
    let sendAttempts = 0;
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/chat.sendMessage")) {
        sendAttempts += 1;
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => '{"success":false,"error":"error-not-allowed"}',
        };
      }
      if (url.endsWith("/channels.join")) {
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" };
      }
      // chat.postMessage fallback
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: { _id: "m3", rid: "R1" } }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    const posted = await new RocketChatClient(CONFIG, fetchImpl).postAsMember("R1", "reply");
    expect(sendAttempts).toBe(2);
    expect(calls.some((c) => c.url.endsWith("/channels.join"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/chat.postMessage"))).toBe(true);
    expect(posted.messageId).toBe("m3");
  });
});

// The replying register: posts as the room's identity and never throws.
describe("RocketChatClient.postReply", () => {
  /** Records calls; `answer` decides each response from the endpoint. */
  function rc(answer: (endpoint: string, body: any) => { ok: boolean; status?: number; json?: unknown; text?: string }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init?.method, headers: init?.headers, body });
      const a = answer(url.split("/api/v1/")[1] ?? "", body);
      return { ok: a.ok, status: a.status ?? (a.ok ? 200 : 400), json: async () => a.json ?? {}, text: async () => a.text ?? "" };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const ok = { ok: true, json: { success: true, message: { _id: "m_1" } } };

  it("posts a threaded reply with tshow through chat.sendMessage when threadShow is on", async () => {
    const { calls, fetchImpl } = rc(() => ok);
    const id = await new RocketChatClient({ ...CONFIG, threadShow: true }, fetchImpl).postReply("R1", "hi", "T1");
    expect(id).toBe("m_1");
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/chat.sendMessage");
    expect(calls[0]?.body).toEqual({ message: { rid: "R1", msg: "hi", tmid: "T1", tshow: true } });
  });

  it("falls back to plain chat.postMessage when chat.sendMessage is refused", async () => {
    const { calls, fetchImpl } = rc((endpoint) => (endpoint === "chat.sendMessage" ? { ok: false, text: "schema" } : ok));
    const lines: string[] = [];
    const client = new RocketChatClient({ ...CONFIG, threadShow: true, log: (l) => lines.push(String(l)) }, fetchImpl);
    expect(await client.postReply("R1", "hi", "T1")).toBe("m_1");
    expect(calls.map((c) => c.url.split("/api/v1/")[1])).toEqual(["chat.sendMessage", "chat.postMessage"]);
    expect(calls[1]?.body).toEqual({ roomId: "R1", text: "hi", tmid: "T1" });
    expect(lines.some((l) => l.includes("falling back"))).toBe(true);
  });

  it("uses plain chat.postMessage by default, and resolves undefined instead of throwing on failure", async () => {
    const { calls, fetchImpl } = rc(() => ({ ok: false, status: 500, text: "boom" }));
    expect(await new RocketChatClient(CONFIG, fetchImpl).postReply("R1", "hi", "T1")).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/chat.postMessage");
  });

  it("resolves undefined when the transport throws", async () => {
    const failing = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(new RocketChatClient(CONFIG, failing).postReply("R1", "hi")).resolves.toBeUndefined();
  });

  it("speaks as the room's identity, and falls back to the bot when the lookup throws", async () => {
    const { calls, fetchImpl } = rc(() => ok);
    const client = new RocketChatClient(
      {
        ...CONFIG,
        identityForRoom: async (roomId) => {
          if (roomId === "BAD") throw new Error("lookup failed");
          return roomId === "DM1" ? { "content-type": "application/json", "X-Auth-Token": "pt", "X-User-Id": "pu" } : undefined;
        },
      },
      fetchImpl,
    );
    await client.postReply("DM1", "hi");
    await client.postReply("R1", "hi");
    await client.postReply("BAD", "hi");
    expect(calls.map((c) => c.headers?.["X-User-Id"])).toEqual(["pu", "u1", "u1"]);
  });

  it("applies `outbound` before the split, so every part carries the voice", async () => {
    const { calls, fetchImpl } = rc(() => ok);
    const client = new RocketChatClient(
      { ...CONFIG, maxMessageChars: 100, outbound: (text) => ({ text, voice: { alias: "Helper" } }) },
      fetchImpl,
    );
    const long = [...Array(40)].map((_, i) => `line ${i}`).join("\n");
    await client.postReply("R1", long, "T1");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.body).toMatchObject({ roomId: "R1", tmid: "T1", alias: "Helper" });
      expect(c.body.text.length).toBeLessThanOrEqual(100);
    }
  });

  it("stops posting into a thread once the post cap is hit, unless the reply is uncapped", async () => {
    const { calls, fetchImpl } = rc(() => ok);
    const client = new RocketChatClient({ ...CONFIG, postCap: { rate: new Map(), maxPosts: 2, windowMs: 60_000 } }, fetchImpl);
    expect(await client.postReply("R1", "a", "T1")).toBe("m_1");
    expect(await client.postReply("R1", "b", "T1")).toBe("m_1");
    expect(await client.postReply("R1", "c", "T1")).toBeUndefined();
    expect(await client.postReply("R1", "d", "T1", { uncapped: true })).toBe("m_1");
    // Another thread has its own budget.
    expect(await client.postReply("R1", "e", "T2")).toBe("m_1");
    expect(calls.map((c) => c.body.text)).toEqual(["a", "b", "d", "e"]);
  });
});

describe("RocketChatClient.applyReactions", () => {
  it("sets each reaction as the room's identity, stating shouldReact, and never throws", async () => {
    const calls: Call[] = [];
    let n = 0;
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, headers: init?.headers, body: JSON.parse(init.body) });
      n += 1;
      if (n === 1) return { ok: false, status: 400, json: async () => ({}), text: async () => "bad emoji" };
      return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" };
    }) as unknown as typeof fetch;
    const client = new RocketChatClient(
      { ...CONFIG, identityForRoom: async () => ({ "content-type": "application/json", "X-Auth-Token": "pt", "X-User-Id": "pu" }) },
      fetchImpl,
    );
    await expect(
      client.applyReactions("R1", "M1", [
        { emoji: "eyes", shouldReact: false },
        { emoji: "white_check_mark", shouldReact: true },
      ]),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.body)).toEqual([
      { messageId: "M1", emoji: "eyes", shouldReact: false },
      { messageId: "M1", emoji: "white_check_mark", shouldReact: true },
    ]);
    expect(calls.every((c) => c.url === "https://chat.test/api/v1/chat.react" && c.headers?.["X-User-Id"] === "pu")).toBe(true);
  });
});

describe("RocketChatClient.isDirectMessage", () => {
  function roomsInfo(answers: Record<string, { ok: boolean; t?: string }>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const id = new URL(url).searchParams.get("roomId") ?? "";
      const a = answers[id] ?? { ok: false };
      return { ok: a.ok, status: a.ok ? 200 : 403, json: async () => ({ room: { t: a.t } }), text: async () => "" };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("reads the type from rooms.info once and caches it", async () => {
    const { calls, fetchImpl } = roomsInfo({ D1: { ok: true, t: "d" }, C1: { ok: true, t: "c" } });
    const client = new RocketChatClient(CONFIG, fetchImpl);
    expect(await client.isDirectMessage("D1")).toBe(true);
    expect(await client.isDirectMessage("D1")).toBe(true);
    expect(await client.isDirectMessage("C1")).toBe(false);
    expect(calls).toEqual([
      "https://chat.test/api/v1/rooms.info?roomId=D1",
      "https://chat.test/api/v1/rooms.info?roomId=C1",
    ]);
    expect(client.cachedRoomType("C1")).toBe("c");
    expect(client.cachedRoomType("nope")).toBeUndefined();
  });

  it("asks the fallback when rooms.info refuses, and caches only a yes", async () => {
    const { calls, fetchImpl } = roomsInfo({});
    const client = new RocketChatClient({ ...CONFIG, isDirectMessageFallback: async (id) => id === "D2" }, fetchImpl);
    expect(await client.isDirectMessage("D2")).toBe(true);
    expect(await client.isDirectMessage("D2")).toBe(true);
    expect(await client.isDirectMessage("X1")).toBe(false);
    expect(await client.isDirectMessage("X1")).toBe(false);
    // D2 was cached after one call; X1 stayed uncertain and was asked twice.
    expect(calls.filter((u) => u.endsWith("D2"))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith("X1"))).toHaveLength(2);
    expect(client.cachedRoomType("X1")).toBeUndefined();
  });
});

describe("RocketChatClient.uploadToRoom", () => {
  it("stores the file with rooms.media, then posts it with rooms.mediaConfirm", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, body: init?.body });
      const json = url.includes("rooms.mediaConfirm") ? { success: true, message: { _id: "m_up" } } : { success: true, file: { _id: "F1" } };
      return { ok: true, status: 200, json: async () => json, text: async () => "" };
    }) as unknown as typeof fetch;
    const posted = await new RocketChatClient(CONFIG, fetchImpl).uploadToRoom(
      "R1",
      { name: "report.txt", bytes: new Uint8Array([104, 105]), contentType: "text/plain" },
      "the report",
    );
    expect(calls[0]?.url).toBe("https://chat.test/api/v1/rooms.media/R1");
    expect(calls[0]?.body).toBeInstanceOf(FormData);
    expect(calls[1]?.url).toBe("https://chat.test/api/v1/rooms.mediaConfirm/R1/F1");
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ msg: "the report" });
    expect(posted).toEqual({ messageId: "m_up", channel: "R1", roomId: "R1" });
  });

  it("refuses to confirm when rooms.media returns no file id", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" })) as unknown as typeof fetch;
    await expect(
      new RocketChatClient(CONFIG, fetchImpl).uploadToRoom("R1", { name: "a", bytes: new Uint8Array(1), contentType: "text/plain" }),
    ).rejects.toThrow(/no file id/);
  });
});

describe("deadlines", () => {
  /** A fetch that only ever settles by aborting. */
  const hanging = (async (_url: string, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    })) as unknown as typeof fetch;

  it("names what timed out on a delivering post, as a typed DeadlineError", async () => {
    const err = await new RocketChatClient({ ...CONFIG, timeoutMs: 10 }, hanging).postToRoom("R1", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.message).toBe("Rocket.Chat chat.postMessage timed out after 0s");
  });

  it("reports a timed-out auth probe as a status, not a throw", async () => {
    const status = await new RocketChatClient({ ...CONFIG, timeoutMs: 10 }, hanging).authStatus();
    expect(status).toEqual({ ok: false, status: 0, error: "Rocket.Chat /api/v1/me timed out after 0s" });
  });
});
