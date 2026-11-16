// The other-bot denylist. We never react to a bot's messages (loop risk / noise).
// Rocket.Chat doesn't reliably set `payload.bot`, so we match on user id/username
// instead: static env, plus an optional JSON file, topped up by ONE `users.list`
// call at boot, never per message. Belt-and-braces: `shouldEngage`
// is what actually holds.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envList, type Log } from "./config.js";
import type { RocketChatClient } from "@practicalworks/rc-client";

/** Roles that make an account a bot. Anything else is a person. */
const BOT_ROLES = new Set(["bot", "app"]);

export interface BotDenylistOptions {
  rc: Pick<RocketChatClient, "get" | "botHeaders">;
  rcUrl: string;
  /** Our own id: never denylisted here, the self-guard owns it. */
  selfUserId: string;
  log: Log;
  env?: NodeJS.ProcessEnv;
}

/** The lists, loaded from env and the file now; `refreshFromRc` tops them up. */
export function createBotDenylist(opts: BotDenylistOptions) {
  const { rc, log } = opts;
  const env = opts.env ?? process.env;
  const ids = new Set<string>(envList("ROCKETCHAT_IGNORE_USER_IDS", env));
  const usernames = new Set<string>(envList("ROCKETCHAT_IGNORE_USERNAMES", env).map((s) => s.toLowerCase()));

  const file = env.ROCKETCHAT_BOT_DENYLIST_FILE ?? path.join(os.homedir(), "rocketchat-bridge", "bot-users.json");
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    log(`no bot denylist file at ${file} — relying on self-guard + env ignore lists`);
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { ids?: string[]; usernames?: string[] };
      for (const id of parsed.ids ?? []) ids.add(id);
      for (const u of parsed.usernames ?? []) usernames.add(u.toLowerCase());
      log(`loaded bot denylist from ${file}: ${ids.size} ids, ${usernames.size} usernames`);
    } catch (err) {
      log(`bot denylist file ${file} is not valid JSON: ${(err as Error)?.message ?? err}`);
    }
  }

  const refreshEnabled = !/^(0|false|no)$/i.test(env.RC_BOT_REFRESH ?? "");

  /**
   * One `users.list` at boot, so the list is never left to be filled by hand.
   * Rocket.Chat ignores a server-side `roles` query and returns every user, which
   * would denylist every human: filter client-side.
   * Best-effort: an account that cannot list users keeps what env and file gave.
   */
  async function refreshFromRc(): Promise<void> {
    if (!refreshEnabled) return log("bot denylist refresh disabled (RC_BOT_REFRESH=0)");
    try {
      const res = await rc.get(
        `${opts.rcUrl}/api/v1/users.list?count=0&fields=${encodeURIComponent(JSON.stringify({ username: 1, roles: 1 }))}`,
        rc.botHeaders(),
        "Rocket.Chat users.list",
      );
      if (!res.ok) {
        log(`bot denylist refresh skipped: users.list returned ${res.status} (needs an admin-capable account)`);
        return;
      }
      const { users = [] } = (await res.json()) as {
        users?: Array<{ _id?: string; username?: string; roles?: string[] }>;
      };

      // FILTER HERE, NOT ON THE SERVER: current Rocket.Chat ignores a `query` on
      // roles and returns EVERY user, which would mute every human.
      const bots = users.filter((u) => (u.roles ?? []).some((r) => BOT_ROLES.has(r.toLowerCase())));

      // Refuse a result that looks unfiltered: denylisting everyone must fail
      // safe rather than quietly mute the bridge.
      if (users.length > 0 && bots.length === users.length) {
        log(
          `bot denylist refresh REFUSED: all ${users.length} accounts claim a bot role, which cannot be right. ` +
            `Keeping the existing list. Set ROCKETCHAT_IGNORE_USERNAMES if you need one.`,
        );
        return;
      }

      let added = 0;
      for (const u of bots) {
        // Never denylist ourselves via this path; an id in two places is a debugging trap.
        if (u._id === opts.selfUserId) continue;
        if (u._id && !ids.has(u._id)) { ids.add(u._id); added++; }
        if (u.username) usernames.add(u.username.toLowerCase());
      }
      log(
        `bot denylist refreshed: ${bots.length} bot account(s) of ${users.length} users, ${added} new` +
          (bots.length ? ` — ${bots.map((b) => b.username).filter(Boolean).join(", ")}` : ""),
      );
    } catch (err) {
      log(`bot denylist refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  return { ids, usernames, refreshFromRc };
}
