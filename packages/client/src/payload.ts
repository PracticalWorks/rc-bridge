/**
 * Which Rocket.Chat endpoint a post goes to, and exactly what body it carries.
 *
 * Pure, so the shapes are unit-tested. `chat.postMessage` validates with
 * `additionalProperties: false`, so ONE extra key turns the whole post into a 400:
 *
 *   must NOT have additional properties
 *   must have required property 'channel'
 *   must match exactly one schema in oneOf
 *
 * "Also send to channel" is `tshow`, and it is a field of chat.sendMessage's
 * `message` object, not a parameter of chat.postMessage. A fake server that
 * accepts any JSON will not catch a mistake here; the real API will.
 */

/** The exact keys `chat.postMessage` accepts. Anything else is a 400, so this
 * list is a hard contract, not documentation. */
const POST_MESSAGE_ALLOWED_KEYS = [
  "roomId",
  "channel",
  "text",
  "tmid",
  "alias",
  "emoji",
  "avatar",
  "attachments",
] as const;

/** The keys `chat.sendMessage`'s nested `message` object accepts. A second
 * contract: this endpoint has its own schema, and a voice on a threaded reply
 * goes inside `message` rather than beside it. */
const SEND_MESSAGE_MESSAGE_ALLOWED_KEYS = [
  "rid",
  "msg",
  "tmid",
  "tshow",
  "alias",
  "avatar",
  "emoji",
  "attachments",
] as const;

/** The keys `chat.react` accepts that this client ever sends. */
const REACT_ALLOWED_KEYS = ["messageId", "emoji", "shouldReact"] as const;

/** Optional voice on a post: a display name and avatar to post under instead of
 * the bot's own. Omitted fields are left off the body entirely. */
export interface PostVoice {
  alias?: string;
  avatar?: string;
}

/** Only the fields Rocket.Chat should see. A blank value is omitted, not sent:
 * Rocket.Chat treats an empty `avatar` as an override to nothing, which is worse
 * than not overriding. */
export function voiceFields(voice: PostVoice | undefined): { alias?: string; avatar?: string } {
  if (!voice) return {};
  return {
    ...(voice.alias ? { alias: voice.alias } : {}),
    ...(voice.avatar ? { avatar: voice.avatar } : {}),
  };
}

export interface RcCall {
  endpoint: "chat.postMessage" | "chat.sendMessage" | "chat.react";
  body: Record<string, unknown>;
}

/**
 * The call that posts `text` into `roomId`, in thread `tmid`.
 *
 * `chat.sendMessage` is used ONLY when `tshow` is actually wanted: a threaded
 * reply with "also send to channel" on. Everything else takes plain
 * `chat.postMessage`. `tshow` is never sent as `false`: an explicit `false` is
 * still an extra property and still a 400, which would make turning the feature
 * off break every post instead.
 */
export function postCall(
  roomId: string,
  text: string,
  tmid: string | undefined,
  threadShow: boolean,
  voice?: PostVoice,
): RcCall {
  if (tmid && threadShow) {
    return {
      endpoint: "chat.sendMessage",
      body: { message: { rid: roomId, msg: text, tmid, tshow: true, ...voiceFields(voice) } },
    };
  }
  return {
    endpoint: "chat.postMessage",
    body: { roomId, text, ...(tmid ? { tmid } : {}), ...voiceFields(voice) },
  };
}

/** The fallback call: plain `chat.postMessage`, which must always be accepted.
 * Used when `chat.sendMessage` fails: losing "also send to channel" is cosmetic,
 * losing the message is not. */
export function fallbackCall(roomId: string, text: string, tmid: string | undefined, voice?: PostVoice): RcCall {
  return {
    endpoint: "chat.postMessage",
    body: { roomId, text, ...(tmid ? { tmid } : {}), ...voiceFields(voice) },
  };
}

/** Set (or clear) a reaction on a message. `emoji` is a shortcode NAME:
 * Rocket.Chat refuses a raw Unicode character. `shouldReact` is always sent,
 * which makes the call a setter: replaying it is harmless, where a bare toggle
 * would flip a reaction back off. The body carries no room, so a caller that
 * posts as a room's identity must name the room separately. */
export function reactCall(messageId: string, emoji: string, shouldReact: boolean): RcCall {
  return { endpoint: "chat.react", body: { messageId, emoji, shouldReact } };
}

/** Keys in a `chat.react` body outside what this client means to send. Empty is
 * the only acceptable answer. */
export function illegalReactKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !(REACT_ALLOWED_KEYS as readonly string[]).includes(k));
}

/** Keys in a `chat.postMessage` body that the API would reject. Empty is the
 * only acceptable answer. */
export function illegalPostKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !(POST_MESSAGE_ALLOWED_KEYS as readonly string[]).includes(k));
}

/** Keys in a `chat.sendMessage` `message` object that the API would reject.
 * Empty is the only acceptable answer. */
export function illegalSendMessageKeys(body: Record<string, unknown>): string[] {
  const message = (body.message ?? {}) as Record<string, unknown>;
  return Object.keys(message).filter((k) => !(SEND_MESSAGE_MESSAGE_ALLOWED_KEYS as readonly string[]).includes(k));
}

/** Which room a call posts into: `chat.postMessage` carries `roomId`,
 * `chat.sendMessage` nests `message.rid`, `chat.react` names none. */
export function roomIdOfCall(body: unknown): string | undefined {
  const b = body as { roomId?: string; message?: { rid?: string } } | undefined;
  return b?.roomId ?? b?.message?.rid;
}
