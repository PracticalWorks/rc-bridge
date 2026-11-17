# @practicalworks/rc-bridge

**Put your AI agent in Rocket.Chat.** A small Node service that relays Rocket.Chat messages
to an agent and posts the answers back, with one conversation per thread, reactions as
receipts, images and files, and streaming. It runs from env with no code, and has a plugin API
for when you want more.

[![npm](https://img.shields.io/npm/v/@practicalworks/rc-bridge)](https://www.npmjs.com/package/@practicalworks/rc-bridge)
[![ci](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/PracticalWorks/rc-bridge/blob/main/LICENSE)

```
Rocket.Chat ──(Outgoing Webhook)──▶ rc-bridge ──▶ agent  POST /v1/responses
     ▲                                  │                        │
     └──────(REST, bot credentials)─────┴──────── answer ◀───────┘
```

**Contents:** [Quick start](#quick-start) · [What it does](#what-it-does) ·
[Troubleshooting](#troubleshooting) · [Configuration reference](#configuration-reference) ·
[Plugins](#plugins) · [Develop](#develop)

## Quick start

About five minutes if you administer a Rocket.Chat.

**You need:**

- Node 20 or later.
- A Rocket.Chat where you can create users and integrations.
- An agent server with an OpenAI-style **Responses API** (`POST /v1/responses`) that accepts a
  *named* conversation: the bridge sends `conversation: "rc:<room>:<thread>"` and expects the
  server to create or continue it. Agent gateways built for chat apps do this. OpenAI's own
  hosted API does not, because it only accepts the `conv_…` ids it issued.
- An HTTPS address Rocket.Chat can reach the bridge on: a reverse proxy, or a tunnel while you
  try it.

**1. Create the bot.** In Rocket.Chat, add a user for the bot (role `bot`), log in as it, and
create a personal access token under *My Account → Personal Access Tokens*. Note its user id,
its token and its username.

**2. Point a webhook at the bridge.** *Administration → Integrations → New → Outgoing*:

- Event trigger: `Message Sent`.
- Channel: the channels it should hear (for example `#ask-agent`), or `all_direct_messages`.
- URLs: `https://<your bridge address>/rocketchat/webhook`.
- Token: invent a long random string. The bridge checks it on every call.

**3. Configure.** Put this in a `.env` file, or in your process manager's env:

```sh
# Your agent server
AGENT_API_URL=https://agent.example.com    # without /v1
AGENT_API_KEY=                             # its bearer token
AGENT_MODEL=agent                          # the `model` sent with each turn

# Rocket.Chat
ROCKETCHAT_URL=https://chat.example.com
ROCKETCHAT_USER_ID=                        # the bot's user id (step 1)
ROCKETCHAT_AUTH_TOKEN=                     # the bot's personal access token (step 1)
ROCKETCHAT_BOT_USERNAME=agent              # the bot's username (step 1)
ROCKETCHAT_WEBHOOK_TOKEN=                  # the token you invented (step 2)
ROCKETCHAT_ALLOWED_ROOM_IDS=               # optional: comma-separated room ids; unset = any room the webhook fires from

PORT=8081
```

**4. Run it.**

```sh
npx @practicalworks/rc-bridge
# or install it: npm install -g @practicalworks/rc-bridge && rc-bridge
```

The bridge does not read `.env` files itself; load the file with your process manager, or with
`node --env-file=.env $(which rc-bridge)` on a global install. It logs what it is listening on, and
`curl http://localhost:8081/health` answers `200`.

**5. Say hello.** In a channel the webhook hears, write `@agent hello`. You should see 👀 on your
message, then the answer in a thread. In a DM with the bot you don't need the @mention.

## What it does

With no plugins:

- **One conversation per thread.** Each turn names a `conversation` (`rc:<roomId>:<thread>`),
  which the agent's Responses API chains server-side. A DM's top-level messages share one
  conversation per room, bounded by a daily epoch; `/new` or `/reset` starts it over.
- **One request, one thread.** The answer goes into the thread the person is in, or a new
  thread rooted on their message.
- **An addressing gate that fails closed.** It answers @mentions, DMs, the person who owns a
  thread, and replies in a thread whose root tagged the bot. Other bots are dropped by
  `payload.bot`, a denylist and a boot-time `users.list` refresh.
- **Reactions as receipts.** 👀 on pickup, then ✅, ⚠️ or ⏳. The answer is posted once, finished,
  because Rocket.Chat notifies on creation and not on edits. An agent can answer with an emoji
  by writing `[react: 👍]`.
- **Attachments.** Images go to the agent inline as `input_image` parts; PDFs and text uploads
  are read to text and put in the prompt. A long paste that Rocket.Chat turned into a file is
  read as the message.
- **Streaming.** When the endpoint streams, the bridge reads the run live, never aborts it, and,
  if the endpoint also serves `GET /v1/runs/{id}`, notices a run parked on an approval.
- **Loop and flood bounds.** A per-thread post cap, a busy guard that holds the next message
  instead of dropping it, and a once-per-outage error reply.
- **Two HTTP routes.** `POST /rocketchat/webhook` (token-checked, acked fast, the turn runs
  detached) and `GET /health` (503 while draining, with recent turn timings).

The bridge has two HTTP routes: `POST /rocketchat/webhook` and `GET /health`. It serves plain HTTP
on `PORT`, so put TLS in front of it.

## Troubleshooting

**No 👀, no answer.** Rocket.Chat never reached the bridge, or the bridge dropped the message.
- *Administration → Integrations → your webhook → History* shows each call and the bridge's
  response. No entry means the trigger did not match: check the event, the channel and that the
  integration is enabled.
- A `401` (`bad token`) in that history means `ROCKETCHAT_WEBHOOK_TOKEN` does not match the integration's token.
- A call that never connected means Rocket.Chat cannot reach your URL: it has to be HTTPS and reachable
  from the Rocket.Chat server, not just from your laptop.
- The message was not addressed to the bot. In a channel, @mention it (or reply in a thread it is
  already in). `RESPOND_TO_ALL=1` answers everything, which is rarely what you want in a busy room.
- The room is not in `ROCKETCHAT_ALLOWED_ROOM_IDS`.

**👀, then ⚠️.** The agent call failed, and the bridge's log has the status and the first 500
characters of the server's reply. A `400` that mentions `conversation` means your server does not
accept named conversations (see *You need* above). A `401` means `AGENT_API_KEY` is wrong.

**👀, then ⏳.** The turn ran past `AGENT_TIMEOUT_MS` (6 minutes by default). The bridge stops
waiting but the agent keeps working in the same conversation, so ask for the result in the thread.

**The bot answers its own messages, or another bot's.** Set `ROCKETCHAT_BOT_USERNAME` to the bot's
real username, and list other bots in `ROCKETCHAT_IGNORE_USERNAMES`.

**Check it's alive:** `GET /health` returns recent turn timings. It returns `503` while the bridge
is shutting down.

## Configuration reference

Names only; set the values in your own environment.

Required:

| Name | What |
|---|---|
| `AGENT_API_KEY` | Bearer token for the agent endpoint |
| `ROCKETCHAT_URL` | Your Rocket.Chat base URL |
| `ROCKETCHAT_USER_ID` | The bot user's id |
| `ROCKETCHAT_AUTH_TOKEN` | The bot user's personal access token |
| `ROCKETCHAT_WEBHOOK_TOKEN` | The Outgoing Webhook's token |

Optional (defaults in `src/config.ts`, `src/state.ts` and `src/denylist.ts`):

| Name | What |
|---|---|
| `AGENT_API_URL` | The OpenAI-compatible endpoint, without `/v1` (default `http://127.0.0.1:8642`) |
| `AGENT_MODEL` | The `model` sent with each turn (default `agent`) |
| `AGENT_TIMEOUT_MS` | How long a turn may take before the bridge stops waiting (default 6 minutes) |
| `AGENT_PARK_CHECK_MS` | Stream silence before asking whether the run parked on an approval |
| `RC_STREAMING` | `0` turns streaming off |
| `ROCKETCHAT_BOT_USERNAME` | The bot's username, for mentions and the self-loop guard (default `bot`) |
| `ROCKETCHAT_TIMEOUT_MS` | Deadline per Rocket.Chat request |
| `RC_THREAD_SHOW` | "Also send to channel" on threaded replies; on by default, `0` turns it off |
| `RC_MAX_MESSAGE_CHARS` | Longer replies are split |
| `RC_MAX_IMAGE_BYTES`, `RC_MAX_IMAGES` | Image limits per turn |
| `RC_MAX_DOCUMENT_BYTES`, `RC_MAX_DOCUMENT_CHARS` | Document limits; the characters are the real bound |
| `RC_UPLOAD_LOOKBACK_MS` | How far back an addressed message looks for the sender's untagged images; `0` is off |
| `RC_LOOP_WINDOW_MS`, `RC_MAX_POSTS_PER_THREAD` | The post cap |
| `RC_BUSY_REPLY_COOLDOWN_MS` | How often "still on the previous message" may be said per conversation |
| `RC_NUDGE_WHEN_IGNORED` | `0` stops the "@mention me" nudge in threads the bot is in |
| `RESPOND_TO_ALL` | `1` answers every message that reaches the bridge, bypassing the addressing gate |
| `ROCKETCHAT_ALLOWED_ROOM_IDS` | Comma-separated room ids allowed to drive the agent |
| `ROCKETCHAT_IGNORE_USER_IDS`, `ROCKETCHAT_IGNORE_USERNAMES` | Static bot denylists, comma-separated |
| `ROCKETCHAT_BOT_DENYLIST_FILE` | A JSON denylist (`{ "ids": [], "usernames": [] }`) |
| `RC_BOT_REFRESH` | `0` skips the boot-time `users.list` refresh |
| `RC_PAUSE_STATE_FILE`, `CONVERSATION_EPOCH_STATE_FILE`, `ENGAGEMENT_STATE_FILE` | State files, under `~/rocketchat-bridge/` by default |
| `PORT` | Listen port (default `8081`) |
| `BRIDGE_DRAIN_DEADLINE_MS` | How long shutdown waits for running turns |

## Plugins

Everything a deployment adds (other voices, routing, approvals, control commands, traces)
arrives through a `BridgePlugin`. Every hook is optional:

| Hook | When it runs | How several plugins compose |
|---|---|---|
| `identityForRoom(roomId)` | Every post, reaction and attachment read: auth headers to speak AS in that room | First non-`undefined` answer wins; none means the bot's own |
| `isDirectMessageFallback(roomId)` | `rooms.info` refused the bot: is this nonetheless a DM? | First non-`undefined` answer wins; none means no |
| `targetForRoom(roomId)` | Which agent endpoint and profile a turn goes to | First non-`undefined` answer wins; none means the default target |
| `isOwnVoice(payload)` | Is this message ours, in a voice the core does not know? | Any `true` drops the message |
| `framing(turn)` | A preamble placed after the context header | Every answer, in plugin order |
| `outbound(text)` | Rewrites a reply before it is split: strip markers, pick a voice (`alias`, `avatar`) | Chained in plugin order; a later voice replaces an earlier one |
| `onAnswer(turn, text)` | Rewrites the answer before its single post | Chained in plugin order |
| `interceptReply(reply)` | A threaded reply, before the addressing gate; `true` consumes it | First `true` wins |
| `onRunParked(turn, run)` | The streamed run parked on an approval | Fan-out, awaited in order |
| `onTurnSettled(record)` | Every turn's outcome, ignored ones included | Fan-out, never awaited; a throw is logged |
| `controlVerbs` | `match(text)` claims a whole message as a command; `nearMiss(text)` answers usage | First match wins |
| `health()` | Fields merged into `/health` | Merged, later plugins win on a key clash |

Order matters only where hooks chain or the first answer wins. `composeHooks(plugins, log)`
applies these rules; `src/hooks.ts` is the whole of it.

A deployment with plugins composes the same pieces `src/main.ts` does, passing its list:

```ts
import { RocketChatClient } from "@practicalworks/rc-client";
import {
  composeHooks, createAgentClient, createAttachmentDeps, createBridgeState, createHttpHandler,
  createLog, createTurnHandler, createTurnTimings, loadCoreConfig, stateFilesFromEnv,
  type BridgePlugin, type WebhookPayload,
} from "@practicalworks/rc-bridge";

const log = createLog();
const config = loadCoreConfig(log);
const plugins: BridgePlugin[] = [myPlugin];
const hooks = composeHooks(plugins, log);
const rc = new RocketChatClient({
  baseUrl: config.rc.url, userId: config.rc.userId, authToken: config.rc.authToken,
  timeoutMs: config.rc.timeoutMs, maxMessageChars: config.rc.maxMessageChars,
  threadShow: config.rc.threadShow, // the client defaults this off; pass it
  postCap: { rate: new Map(), maxPosts: config.loop.maxPostsPerThread, windowMs: config.loop.windowMs },
  log,
  identityForRoom: (roomId) => hooks.identityForRoom(roomId),
  isDirectMessageFallback: (roomId) => hooks.isDirectMessageFallback(roomId),
  outbound: (text) => hooks.outbound(text),
});
// …then createAttachmentDeps, createAgentClient, createBridgeState, createTurnHandler and
// createHttpHandler, exactly as in src/main.ts.
```

## Develop

From the repository root: `pnpm install`, then `pnpm build && pnpm typecheck && pnpm test`.
`src/boundary.test.ts` fails on any import outside this package, node built-ins and its
declared dependencies; `src/core.e2e.test.ts` runs `src/main.ts` against a fake Rocket.Chat and
a fake agent.

MIT licensed.
