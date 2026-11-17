# @practicalworks/rc-bridge

Puts Rocket.Chat in front of an OpenAI-compatible agent. A Rocket.Chat **Outgoing
Webhook** POSTs each message to the bridge; the bridge sends the turn to the agent's
`/v1/responses` endpoint and posts the answer back through Rocket.Chat's REST API as the
bot user, via [`@practicalworks/rc-client`](../client).

```
Rocket.Chat ──(Outgoing Webhook)──▶ rc-bridge ──▶ agent  POST /v1/responses
     ▲                                  │                        │
     └──────(REST, bot credentials)─────┴──────── answer ◀───────┘
```

What the relay does on its own, with no plugins:

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

## Run it

Node 20 or later.

```sh
npx @practicalworks/rc-bridge        # or: rc-bridge, once installed
```

It listens on `PORT` over plain HTTP; put TLS in front of it (a reverse proxy or a tunnel),
since Rocket.Chat needs an HTTPS URL to reach it.

### Rocket.Chat setup

1. A bot user for the bridge, and a personal access token for it. Its user id and token are
   `ROCKETCHAT_USER_ID` and `ROCKETCHAT_AUTH_TOKEN`; its username is `ROCKETCHAT_BOT_USERNAME`.
2. **Administration → Integrations → New → Outgoing**: event `Message Sent`, the channels it
   should hear, URL `https://<where the bridge is reachable>/rocketchat/webhook`, and a token
   you invent, which is also `ROCKETCHAT_WEBHOOK_TOKEN`.
3. Set `ROCKETCHAT_ALLOWED_ROOM_IDS` to the rooms allowed to drive the agent. Unset, any room the
   webhook fires from can.

### Environment

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
