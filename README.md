# rc-bridge

Rocket.Chat tooling, in one place to review.

| Path | What |
|---|---|
| `packages/client` | `@practicalworks/rc-client`: a typed client for Rocket.Chat's REST API. Posts by name, room or thread, replies that never throw, reactions, room type, uploads, auth status, and splitting a message Rocket.Chat would refuse |
| `packages/bridge` | `@practicalworks/rc-bridge`: puts Rocket.Chat in front of an OpenAI-compatible agent. An outgoing-webhook relay with one conversation per thread, reactions as receipts, attachments, streaming, and a `BridgePlugin` seam. Runs with no plugins from env (`npx @practicalworks/rc-bridge`); see its README |

Nothing private lives here: no credentials, no instance hostnames or LAN addresses, no internal ticket references, no brand data. Those are injected at run time. `pnpm guard` enforces it on every tracked file in CI; `pnpm guard:history` runs the same check over every commit's patch.

```sh
pnpm install
pnpm guard && pnpm build && pnpm typecheck && pnpm test
```

Releases: bump a package's `version`; merging to `main` publishes it to npm with provenance through npm trusted publishing (no token in the repo) and verifies the registry attestation before the job succeeds (`.github/workflows/publish.yml`). Check a specific release locally with `pnpm verify:npm-provenance`.

MIT licensed.
