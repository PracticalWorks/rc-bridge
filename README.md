# rc-bridge

**Put your AI agent in Rocket.Chat.** Talk to it in channels, threads and DMs the way you talk to a teammate.

[![rc-bridge on npm](https://img.shields.io/npm/v/@practicalworks/rc-bridge?label=%40practicalworks%2Frc-bridge)](https://www.npmjs.com/package/@practicalworks/rc-bridge)
[![rc-client on npm](https://img.shields.io/npm/v/@practicalworks/rc-client?label=%40practicalworks%2Frc-client)](https://www.npmjs.com/package/@practicalworks/rc-client)
[![ci](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/PracticalWorks/rc-bridge/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Two TypeScript packages, taken from the Rocket.Chat bridge we run in production every day:

| Package | Use it when |
|---|---|
| [**`@practicalworks/rc-bridge`**](packages/bridge) | You run an agent behind an OpenAI-style `/v1/responses` endpoint and want people to reach it from Rocket.Chat. One process, configured from env, no code. |
| [**`@practicalworks/rc-client`**](packages/client) | You want to post to Rocket.Chat from your own code (a cron job, a CI step, a tool your agent calls) without hand-writing REST calls. Typed, no runtime dependencies. |

## What the bridge gives you

- **One conversation per thread.** Each Rocket.Chat thread is its own agent conversation, and the agent's memory follows it.
- **It answers when it's addressed.** @mentions, DMs and threads it was pulled into get an answer. It doesn't jump into every message, and it ignores other bots.
- **Receipts you can see.** 👀 when it picks a message up, then ✅, ⚠️ or ⏳. One finished answer, not a flood of edits.
- **Screenshots and files.** Images go to the agent as images; PDFs and text files are read in.
- **Long runs are fine.** It streams, never cuts a run off, and notices when a run is waiting on a human approval.
- **Extensible.** A small, documented `BridgePlugin` API adds personas, routing, approvals or chat commands without forking.

```
Rocket.Chat ──(Outgoing Webhook)──▶ rc-bridge ──▶ your agent  POST /v1/responses
     ▲                                  │                            │
     └──────(REST, bot credentials)─────┴────────── answer ◀─────────┘
```

## Quick start

**The bridge**, with Node 20+ and a Rocket.Chat you administer:

```sh
npx @practicalworks/rc-bridge
```

It refuses to start until its five required settings are present. The [bridge README](packages/bridge#quick-start) has the 5-minute setup: the bot user, the webhook and a sample `.env`.

**The client**, in your own code:

```sh
npm install @practicalworks/rc-client
```

```ts
import { RocketChatClient } from "@practicalworks/rc-client";

const rc = new RocketChatClient({
  baseUrl: "https://chat.example.com",
  userId: process.env.RC_USER_ID!,
  authToken: process.env.RC_AUTH_TOKEN!,
});

await rc.postToChannel("#deploys", "v2.3.0 is live.");
```

## Trust

- **Provenance on every release.** Each version is built and published from this repo's `main` by GitHub Actions through npm trusted publishing: no long-lived token exists. The job checks the registry's [SLSA provenance](https://slsa.dev) attestation before it passes, and you can check it yourself with `npm audit signatures`.
- **Nothing private in the repo.** `pnpm guard` runs in CI and fails on credentials, private hostnames or addresses and internal references, over every tracked file. `pnpm guard:history` checks every commit.
- **Small surface.** The client has no runtime dependencies. A test fails the build if the bridge imports anything outside its declared dependencies.

## Develop

```sh
pnpm install
pnpm guard && pnpm build && pnpm typecheck && pnpm test
```

Issues and pull requests are welcome. Please open an issue before a large change, so we can agree on the shape first. To release, bump a package's `version` in its `package.json`; merging to `main` publishes it.

**Security:** please report a vulnerability privately through [GitHub's security advisories](https://github.com/PracticalWorks/rc-bridge/security/advisories/new), not in a public issue.

## Who makes this

[Practical Works](https://practical.works), a small software shop in Tampa Bay. Our team works in Rocket.Chat with agents in the room every day; this is the part of that setup we could pull out and share, and we maintain it because we depend on it.

Questions, bug reports and ideas are welcome in [issues](https://github.com/PracticalWorks/rc-bridge/issues). And if you need a hand shipping an app or putting an agent to work, we [take on projects](https://practical.works).

MIT licensed.
