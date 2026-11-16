// The core's env knobs, read once and frozen. Whatever a deployment's plugins
// need from the environment, they read for themselves.
import { DEFAULT_LOOP_WINDOW_MS, DEFAULT_MAX_POSTS_PER_THREAD, RC_MAX_MESSAGE_CHARS } from "@practicalworks/rc-client";

export type Log = (...a: unknown[]) => void;

/** Timestamped: a line that repeats on a timer and carries no time cannot say
 * whether you are reading now or an hour ago. */
export function createLog(prefix = "rc-bridge"): Log {
  return (...a: unknown[]) => console.error(`[${prefix} ${new Date().toISOString()}]`, ...a);
}

/** A missing required var refuses to start: log it and exit 1. */
export function required(name: string, log: Log, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) {
    log(`${name} is required. Refusing to start.`);
    process.exit(1);
  }
  return v;
}

export function envList(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "@bot remind me about that", a few minutes after an untagged upload. */
export const DEFAULT_UPLOAD_LOOKBACK_MS = 10 * 60_000;

const isOff = (v: string | undefined) => /^(0|false|no)$/i.test(v ?? "");
const isOn = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? "");

export interface CoreConfig {
  agent: { url: string; apiKey: string; model: string; timeoutMs: number; parkCheckMs: number; streaming: boolean };
  rc: {
    url: string;
    userId: string;
    authToken: string;
    webhookToken: string;
    botUsername: string;
    timeoutMs: number;
    threadShow: boolean;
    maxMessageChars: number;
  };
  attachments: {
    maxBytes: number;
    maxImages: number;
    maxDocumentBytes: number;
    maxDocumentChars: number;
    /** How far back an addressed channel message looks for the sender's untagged images; 0 = off. */
    lookbackMs: number;
  };
  loop: { windowMs: number; maxPostsPerThread: number; busyReplyCooldownMs: number };
  nudgeWhenIgnored: boolean;
  respondToAll: boolean;
  allowedRoomIds: readonly string[];
  port: number;
  drainDeadlineMs: number;
}

function deepFreeze<T extends object>(o: T): Readonly<T> {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v as object);
  return Object.freeze(o);
}

/** Every core knob with its default. Required vars are checked in the order
 * they always were: the agent key first, then the four Rocket.Chat values. */
export function loadCoreConfig(log: Log, env: NodeJS.ProcessEnv = process.env): Readonly<CoreConfig> {
  const agentUrl = (env.AGENT_API_URL ?? "http://127.0.0.1:8642").replace(/\/$/, "");
  const agentKey = required("AGENT_API_KEY", log, env);
  const rcUrl = required("ROCKETCHAT_URL", log, env).replace(/\/$/, "");
  const rcUserId = required("ROCKETCHAT_USER_ID", log, env);
  const rcAuthToken = required("ROCKETCHAT_AUTH_TOKEN", log, env);
  const rcWebhookToken = required("ROCKETCHAT_WEBHOOK_TOKEN", log, env);

  const allowedRoomIds = envList("ROCKETCHAT_ALLOWED_ROOM_IDS", env);
  if (allowedRoomIds.length === 0) {
    log(
      "ROCKETCHAT_ALLOWED_ROOM_IDS is not set — any room or DM that can reach this bridge can drive the agent. Set it to lock this down.",
    );
  }

  return deepFreeze({
    agent: {
      url: agentUrl,
      apiKey: agentKey,
      model: env.AGENT_MODEL ?? "agent",
      // Long on purpose: an agent errand can run minutes of tool calls.
      timeoutMs: Number(env.AGENT_TIMEOUT_MS ?? 360_000),
      // Silence before asking whether the run parked on an approval.
      parkCheckMs: Number(env.AGENT_PARK_CHECK_MS ?? 90_000),
      streaming: !isOff(env.RC_STREAMING),
    },
    rc: {
      url: rcUrl,
      userId: rcUserId,
      authToken: rcAuthToken,
      webhookToken: rcWebhookToken,
      botUsername: (env.ROCKETCHAT_BOT_USERNAME ?? "bot").toLowerCase(),
      timeoutMs: Number(env.ROCKETCHAT_TIMEOUT_MS ?? 15_000),
      // "Also send to channel" on threaded posts; RC_THREAD_SHOW=0 turns it off.
      threadShow: !isOff(env.RC_THREAD_SHOW),
      // Under RC's Message_MaxAllowedSize (5000); longer replies are split.
      maxMessageChars: Number(env.RC_MAX_MESSAGE_CHARS ?? RC_MAX_MESSAGE_CHARS),
    },
    attachments: {
      // Raw bytes; base64 inflates them ~4/3 on the wire.
      maxBytes: Number(env.RC_MAX_IMAGE_BYTES ?? 3_500_000),
      maxImages: Number(env.RC_MAX_IMAGES ?? 4),
      // PDF text is pasted into the prompt, so the extracted CHARS are the real bound.
      maxDocumentBytes: Number(env.RC_MAX_DOCUMENT_BYTES ?? 25_000_000),
      maxDocumentChars: Number(env.RC_MAX_DOCUMENT_CHARS ?? 120_000),
      lookbackMs: Number(env.RC_UPLOAD_LOOKBACK_MS ?? DEFAULT_UPLOAD_LOOKBACK_MS),
    },
    loop: {
      windowMs: Number(env.RC_LOOP_WINDOW_MS ?? DEFAULT_LOOP_WINDOW_MS),
      maxPostsPerThread: Number(env.RC_MAX_POSTS_PER_THREAD ?? DEFAULT_MAX_POSTS_PER_THREAD),
      busyReplyCooldownMs: Number(env.RC_BUSY_REPLY_COOLDOWN_MS ?? 5 * 60_000),
    },
    nudgeWhenIgnored: !isOff(env.RC_NUDGE_WHEN_IGNORED),
    // Escape hatch: answer every message that reaches us, not just @mentions and DMs.
    respondToAll: isOn(env.RESPOND_TO_ALL),
    allowedRoomIds,
    port: Number(env.PORT ?? 8081),
    // Decoupled from the agent turn ceiling: a deploy should not stall for minutes.
    drainDeadlineMs: Number(env.BRIDGE_DRAIN_DEADLINE_MS ?? 135_000),
  });
}
