#!/usr/bin/env node
// The relay with NO plugins: what someone running only the connector starts
// (`rc-bridge`, or `tsx src/main.ts` from a checkout). Core env only
// (config.ts), plain HTTP, the state files under ~/rocketchat-bridge/.
// core.e2e.test.ts spawns this file to prove the core stands alone. A deployment
// with plugins composes these same pieces, with its own list in `plugins`.
import http from "node:http";
import { RocketChatClient } from "@practicalworks/rc-client";
import { createAgentClient } from "./agent.js";
import { createAttachmentDeps } from "./attachment-deps.js";
import { createLog, loadCoreConfig } from "./config.js";
import { createBotDenylist } from "./denylist.js";
import { composeHooks } from "./hooks.js";
import { createHttpHandler } from "./http.js";
import type { BridgePlugin, WebhookPayload } from "./plugin.js";
import { createBridgeState, stateFilesFromEnv } from "./state.js";
import { createTurnHandler } from "./turn.js";
import { createTurnTimings } from "./turn-timings.js";

const log = createLog();
const config = loadCoreConfig(log);
const plugins: BridgePlugin[] = [];
const hooks = composeHooks(plugins, log);

const rc = new RocketChatClient({
  baseUrl: config.rc.url,
  userId: config.rc.userId,
  authToken: config.rc.authToken,
  timeoutMs: config.rc.timeoutMs,
  // Passed explicitly: the client defaults it to off, the bridge to on.
  threadShow: config.rc.threadShow,
  maxMessageChars: config.rc.maxMessageChars,
  postCap: { rate: new Map(), maxPosts: config.loop.maxPostsPerThread, windowMs: config.loop.windowMs },
  log,
  identityForRoom: (roomId) => hooks.identityForRoom(roomId),
  isDirectMessageFallback: (roomId) => hooks.isDirectMessageFallback(roomId),
  outbound: (text) => hooks.outbound(text),
});
const attachmentDepsFor = createAttachmentDeps({ rc, rcUrl: config.rc.url, limits: config.attachments, log });
const agent = createAgentClient({
  timeoutMs: config.agent.timeoutMs,
  parkCheckMs: config.agent.parkCheckMs,
  streaming: config.agent.streaming,
  log,
});
const state = createBridgeState<WebhookPayload>({ ...stateFilesFromEnv(), log });
const denylist = createBotDenylist({ rc, rcUrl: config.rc.url, selfUserId: config.rc.userId, log });
const turnTimings = createTurnTimings();

// Turns run detached after the webhook's 200; shutdown waits for these.
let draining = false;
const running = new Set<Promise<unknown>>();
const inFlight = {
  count: () => running.size,
  track(work: Promise<void>): void {
    running.add(work);
    void work.catch(() => {}).finally(() => running.delete(work));
  },
};

const turns = createTurnHandler({
  config,
  log,
  rc,
  attachmentDepsFor,
  agent,
  state,
  turnTimings,
  hooks,
  bot: { userId: config.rc.userId, username: config.rc.botUsername },
  denylist: { ids: denylist.ids, usernames: denylist.usernames },
  defaultTarget: { url: config.agent.url, apiKey: config.agent.apiKey, model: config.agent.model },
  track: (work) => inFlight.track(work),
  isDraining: () => draining,
});

const server = http.createServer(
  createHttpHandler({
    port: config.port,
    tlsEnabled: false,
    webhookToken: config.rc.webhookToken,
    isDraining: () => draining,
    inFlight,
    handleMessage: turns.handleMessage,
    pluginHealth: hooks.health,
    turns: turnTimings.list,
  }),
);

process.on("unhandledRejection", (reason) => log("unhandledRejection:", reason));

// Stop taking webhooks (RC gets a 503 and may resend), let running turns finish
// within the drain deadline, then exit.
function shutdown(signal: string): void {
  if (draining) return;
  draining = true;
  log(`${signal} received — draining, ${running.size} turn(s) still running`);
  setTimeout(() => {
    log(`drain deadline hit — abandoning ${running.size} turn(s)`);
    process.exit(0);
  }, config.drainDeadlineMs).unref();
  void (async () => {
    while (running.size > 0) await Promise.allSettled([...running]);
    server.close(() => process.exit(0));
  })();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, () => {
  log(`core relay listening on http://:${config.port} — POST /rocketchat/webhook · agent → ${config.agent.url}`);
  void denylist.refreshFromRc();
});
