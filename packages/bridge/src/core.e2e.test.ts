// End-to-end, the core ALONE: `src/main.ts` (no plugins) as a real process,
// against a strict fake Rocket.Chat and a fake streaming agent. It proves the
// relay runs from its documented env with nothing but this package and the
// Rocket.Chat client.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const POST_ALLOWED = new Set(["roomId", "channel", "text", "tmid", "alias", "emoji", "avatar", "attachments"]);
const KNOWN_REACTIONS = new Set(["eyes", "white_check_mark", "warning", "hourglass_flowing_sand", "thumbsup"]);

interface Posted {
  roomId: string;
  text: string;
  tmid?: string;
}
interface Reaction {
  messageId: string;
  emoji: string;
  shouldReact: boolean;
}

/** In order: every post and every reaction, as the room sees them. */
const events: Array<{ post: Posted } | { react: Reaction }> = [];
/** Hold a message's ✅ back this many ms, as a slow runner does. */
const receiptDelayMs = new Map<string, number>();
let usersListed = false;
/** Threads a `chat.sendMessage` (the "also send to channel" path) was tried for. */
const sendMessageTmids: string[] = [];

/** Refuses what the real API refuses: extra postMessage fields, unknown emoji
 * names, oversized text. Room ids beginning `DM` are direct messages. */
function strictFakeRc(): http.Server {
  let nextId = 1;
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://rc");
      const endpoint = url.pathname.replace("/api/v1/", "");
      const json = (code: number, body: unknown) =>
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.headers["x-auth-token"] !== "rc-token") return json(401, { success: false });

      if (endpoint === "rooms.info") {
        return json(200, { room: { t: (url.searchParams.get("roomId") ?? "").startsWith("DM") ? "d" : "c" } });
      }
      if (endpoint === "chat.getMessage") return json(200, { message: { msg: "" } });
      if (endpoint === "users.list") {
        usersListed = true;
        return json(200, {
          users: [
            { _id: "bb1", username: "other-bot", roles: ["bot"] },
            { _id: "ma1", username: "maria", roles: ["user"] },
          ],
        });
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (endpoint === "chat.react") {
        const extra = Object.keys(body).filter((k) => !["messageId", "emoji", "shouldReact"].includes(k));
        if (extra.length || typeof body.messageId !== "string" || !KNOWN_REACTIONS.has(String(body.emoji))) {
          return json(400, { success: false });
        }
        const ev = { react: { messageId: body.messageId, emoji: String(body.emoji), shouldReact: body.shouldReact !== false } };
        const delay = body.emoji === "white_check_mark" ? receiptDelayMs.get(body.messageId) : undefined;
        if (delay) {
          setTimeout(() => {
            events.push(ev);
            json(200, { success: true });
          }, delay);
          return;
        }
        events.push(ev);
        return json(200, { success: true });
      }
      if (endpoint === "chat.postMessage") {
        const extra = Object.keys(body).filter((k) => !POST_ALLOWED.has(k));
        if (extra.length) return json(400, { success: false, error: `must NOT have additional properties: ${extra}` });
        const text = String(body.text ?? "");
        if (text.length > 5000) return json(400, { success: false, error: "error-message-size-exceeded" });
        events.push({ post: { roomId: String(body.roomId), text, ...(body.tmid ? { tmid: String(body.tmid) } : {}) } });
        return json(200, { success: true, message: { _id: `msg${nextId++}` } });
      }
      if (endpoint === "chat.sendMessage") {
        // Recorded, then refused like any endpoint this fake lacks, so the
        // fallback to chat.postMessage is what delivers the reply.
        const message = (body.message ?? {}) as Record<string, unknown>;
        if (message.tshow === true) sendMessageTmids.push(String(message.tmid));
      }
      return json(404, { success: false, error: `fake RC has no ${endpoint}` });
    });
  });
}

/** Streams two deltas, then completes. Counts turns, so "ignored" can mean zero calls. */
let agentTurns = 0;
function fakeAgent(): http.Server {
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      if (req.headers.authorization !== "Bearer test-key") return res.writeHead(401).end();
      agentTurns++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of ["Hello", " from core"]) {
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const response = { output: [{ type: "message", content: [{ type: "output_text", text: "Hello from core" }] }] };
      res.write(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
      res.end();
    });
  });
}

const listen = async (s: http.Server): Promise<number> => {
  s.listen(0);
  await once(s, "listening");
  return (s.address() as { port: number }).port;
};

let rc: http.Server;
let agent: http.Server;
let relay: ChildProcess;
let relayPort: number;
let fixtureDir: string;

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function webhook(payload: Record<string, unknown>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${relayPort}/rocketchat/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "wh-token", ...payload }),
  });
  await res.text();
  return res.status;
}

const posts = () => events.flatMap((e) => ("post" in e ? [e.post] : []));

beforeAll(async () => {
  rc = strictFakeRc();
  agent = fakeAgent();
  const [rcPort, agentPort] = await Promise.all([listen(rc), listen(agent)]);

  // Every state path and the denylist file default under os.homedir(), and a
  // machine running this suite may also run a real bridge. HOME is the fixture,
  // and ~/rocketchat-bridge/ exists in it as it would on a host.
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), "core-e2e-"));
  mkdirSync(path.join(fixtureDir, "rocketchat-bridge"), { recursive: true });

  const probe = http.createServer();
  relayPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const here = path.dirname(fileURLToPath(import.meta.url));
  relay = spawn("npx", ["tsx", path.join(here, "main.ts")], {
    env: {
      PATH: process.env.PATH,
      HOME: fixtureDir,
      PORT: String(relayPort),
      AGENT_API_KEY: "test-key",
      AGENT_API_URL: `http://127.0.0.1:${agentPort}`,
      ROCKETCHAT_URL: `http://127.0.0.1:${rcPort}`,
      ROCKETCHAT_USER_ID: "bot-id",
      ROCKETCHAT_AUTH_TOKEN: "rc-token",
      ROCKETCHAT_WEBHOOK_TOKEN: "wh-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  relay.stdout?.on("data", (c) => (output += c));
  relay.stderr?.on("data", (c) => (output += c));
  await until(`the relay to listen (output so far: ${output})`, () => output.includes("core relay listening"), 30_000);
  // The denylist is topped up from users.list after listen; case (d) needs it.
  await until("the boot users.list", () => usersListed);
}, 40_000);

beforeEach(() => {
  events.length = 0;
  agentTurns = 0;
});

afterAll(() => {
  relay?.kill();
  rc?.close();
  agent?.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("the core relay, with no plugins", () => {
  it("answers an @mention in a channel: 👀, then the answer once, then ✅", async () => {
    expect(await webhook({ channel_id: "C1", user_id: "ma1", user_name: "maria", text: "@bot hi", message_id: "m1" })).toBe(200);
    await until("the ✅", () => events.some((e) => "react" in e && e.react.emoji === "white_check_mark"));

    expect(posts()).toEqual([{ roomId: "C1", text: "Hello from core", tmid: "m1" }]);
    const order = events.map((e) => ("post" in e ? "post" : `${e.react.shouldReact ? "+" : "-"}${e.react.emoji}`));
    expect(order.indexOf("+eyes")).toBeLessThan(order.indexOf("post"));
    expect(order.indexOf("post")).toBeLessThan(order.indexOf("+white_check_mark"));
    expect(agentTurns).toBe(1);
  });

  it("answers a DM without a mention", async () => {
    // The ✅ arrives 300ms late, as it can on a slow CI runner. A
    // test that stops at the post leaves it to land in the NEXT test's window.
    receiptDelayMs.set("m2", 300);
    expect(await webhook({ channel_id: "DM1", user_id: "ma1", user_name: "maria", text: "what's up", message_id: "m2" })).toBe(200);
    // Wait for the ✅, not the post: the receipt lands AFTER the answer, and a
    // turn left settling leaks its reactions into the next test.
    await until("the DM ✅", () =>
      events.some((e) => "react" in e && e.react.messageId === "m2" && e.react.emoji === "white_check_mark"),
    );
    expect(posts().map((p) => [p.roomId, p.text])).toEqual([["DM1", "Hello from core"]]);
    // The turn is over only once its receipt is in: this test owns its own ✅.
    expect(events).toContainEqual({ react: { messageId: "m2", emoji: "white_check_mark", shouldReact: true } });
  });

  it("asks Rocket.Chat to also show a threaded reply in the channel, by default", async () => {
    // The client defaults this off; the relay's default is on, so main.ts must pass it.
    expect(sendMessageTmids).toContain("m1");
  });

  it("/health says ok and carries the turn timings", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
    const body = (await res.json()) as { ok: boolean; draining: boolean; inFlight: number; turns: unknown[] };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, draining: false });
    expect(typeof body.inFlight).toBe("number");
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.turns.length).toBeGreaterThan(0);
  });

  it("ignores another bot, even when it @mentions us", async () => {
    expect(await webhook({ channel_id: "C1", user_id: "bb1", user_name: "other-bot", text: "@bot loop?", message_id: "m3" })).toBe(200);
    expect(await webhook({ channel_id: "C1", user_id: "x1", user_name: "hook", bot: { i: "int1" }, text: "@bot hi", message_id: "m4" })).toBe(200);
    await new Promise((r) => setTimeout(r, 600));
    // Only THESE messages: another test's late receipt is not this one's business.
    const ours = new Set(["m3", "m4"]);
    expect(events.filter((e) => ("react" in e ? ours.has(e.react.messageId) : ours.has(e.post.tmid ?? "")))).toEqual([]);
    expect(agentTurns).toBe(0);
  });
});
