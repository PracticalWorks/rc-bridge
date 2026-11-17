# @practicalworks/rc-client

**A typed [Rocket.Chat](https://www.rocket.chat) REST client for Node, with no runtime dependencies.**
Post to a channel, a DM, a room or a thread; react; upload files; check auth. Every message is
split to fit Rocket.Chat's size limit, so long output never gets refused.

[![npm](https://img.shields.io/npm/v/@practicalworks/rc-client)](https://www.npmjs.com/package/@practicalworks/rc-client)
[![ci](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/PracticalWorks/rc-bridge/blob/main/LICENSE)

Use it for the jobs that tell people things: a deploy notice, a nightly report, an alert, a tool
your AI agent calls to message the team. It is the client inside
[`@practicalworks/rc-bridge`](https://www.npmjs.com/package/@practicalworks/rc-bridge).

## Install

```sh
npm install @practicalworks/rc-client
```

Node 20 or later (it uses the global `fetch`, `FormData` and `Blob`).

## Quick start

Create a bot user in Rocket.Chat and a personal access token for it (*My Account → Personal
Access Tokens*); the token page shows the user id too.

```ts
import { RocketChatClient } from "@practicalworks/rc-client";

const rc = new RocketChatClient({
  baseUrl: "https://chat.example.com",
  userId: process.env.RC_USER_ID!,
  authToken: process.env.RC_AUTH_TOKEN!,
});

await rc.postToChannel("#deploys", "v2.3.0 is live.");   // a channel
await rc.postToChannel("@sam", "Your report is ready.");  // a DM, opened if needed

const status = await rc.authStatus();                     // { ok, status, error? }, never throws
```

The base URL and credentials come from the caller and are never stored or logged. Pass your
own `fetch` as the second constructor argument to test or proxy.

## Two registers

**Delivering**: as the bot, and **throws** on failure. For a scheduled job or a tool call, a message that silently vanished is worse than an error.

- `postToChannel(target, text, voice?)`: `#name` or a bare name is a channel, `@name` a DM (Rocket.Chat opens the DM room if needed). A discussion that does not answer to its generated name is found by its display name among the rooms the bot has joined; two rooms with the same display name refuse rather than guess. Only a failure Rocket.Chat itself classified as an unknown room triggers that lookup.
- `postToRoom(roomId, text, tmid?, voice?)`: into a room by id, optionally inside a thread.
- `postAsMember(roomId, text, { tmid?, voice? })`: `chat.sendMessage`; on `error-not-allowed` it joins the channel and retries, then falls back to `chat.postMessage`.
- `uploadToRoom(roomId, { name, bytes, contentType }, caption?)`: `rooms.media` then `rooms.mediaConfirm` (Rocket.Chat 7.0 removed `rooms.upload`).
- `getMessage(id)`: null when the message is missing or not visible to the bot.

Failures are typed: `RocketChatApiError` carries `status`, `endpoint` and Rocket.Chat's `rcError`; `RocketChatPostError` adds `unknownRoom`; a timeout is a `DeadlineError`.

**Replying**: as the room's identity, and **never throws**. For a live conversation, a failed post is logged and the conversation carries on.

- `postReply(roomId, text, tmid?, { uncapped? })`: returns the first part's id, or undefined. With `threadShow` it sends a threaded reply to the channel too (`chat.sendMessage` with `tshow`), and falls back to plain `chat.postMessage` if that is refused. `postCap` bounds posts per thread inside a window; `uncapped` exempts a control reply. `outbound` rewrites the text and picks a voice before the split.
- `applyReactions(roomId, messageId, [{ emoji, shouldReact }])`: sets or clears each reaction, always stating `shouldReact`.
- `post(endpoint, body, roomId?)`: a raw JSON POST as the room's identity, resolving `{ ok, id?, detail? }`.

`identityForRoom(roomId)` returns the headers to speak as in a room (another user's token, say), or undefined for the bot's own; `headersForRoom` exposes the result, and `get(url, headers, label)` makes a GET with the client's deadline.

**Both**: `authStatus()` probes `/api/v1/me` and reports `{ ok, status, error? }` without throwing. `isDirectMessage(roomId)` reads the room type from `rooms.info` and caches it (`cachedRoomType`); when `rooms.info` refuses, `isDirectMessageFallback` is asked. `react(messageId, emoji, shouldReact?)` reacts as the bot and toggles when `shouldReact` is omitted. `joinRoom(roomId)` returns whether a public channel join worked.

## Helpers

- `splitForRc(text, max?, maxParts?)`: splits on line boundaries, closes and reopens a ``` fence across a split, and ends a runaway text with a truncation notice. `RC_MAX_MESSAGE_CHARS` (4000) and `RC_MAX_PARTS` (5) are the defaults.
- `postCall`, `fallbackCall`, `reactCall` build the exact bodies Rocket.Chat accepts; `illegalPostKeys`, `illegalSendMessageKeys` and `illegalReactKeys` check a body against the endpoint's schema. `chat.postMessage` rejects any extra key.
- `normalizeChannel`, `isDirectTarget` and `normalizeTargets` fold targets for an allowlist. An empty list is an empty set: treat it as "posting is off".
- `withinRate` is the sliding-window counter behind `postCap`; `DEFAULT_MAX_POSTS_PER_THREAD` and `DEFAULT_LOOP_WINDOW_MS` are a starting point.
- `fetchWithTimeout` and `DeadlineError` are the deadline every call runs under.

MIT licensed.
