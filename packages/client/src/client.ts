import { fetchWithTimeout } from "./deadline.js";
import {
  namesUnknownRoom,
  parseErrorBody,
  RocketChatApiError,
  RocketChatPostError,
  type RocketChatErrorBody,
} from "./errors.js";
import { fallbackCall, postCall, reactCall, roomIdOfCall, voiceFields, type PostVoice } from "./payload.js";
import { withinRate } from "./rate.js";
import { RC_MAX_MESSAGE_CHARS, splitForRc } from "./split.js";
import { normalizeChannel } from "./targets.js";

/** Request headers, as plain strings. */
export type RcHeaders = Record<string, string>;

/** Where diagnostics go. Never handed a credential. */
export type RcLog = (...args: unknown[]) => void;

/** A Rocket.Chat bot identity and how this client posts with it. */
export interface RocketChatConfig {
  baseUrl: string;
  userId: string;
  authToken: string;
  /** Hard deadline per request; Rocket.Chat's REST API answers in seconds. Default 15s. */
  timeoutMs?: number;
  /** Ceiling per message before a text is split. Default `RC_MAX_MESSAGE_CHARS`. */
  maxMessageChars?: number;
  /** `postReply` only: send a threaded reply to the channel too ("also send to
   * channel", `tshow`). Default off. */
  threadShow?: boolean;
  /** `postReply` only: the post cap. `rate` holds per-thread timestamps and is
   * owned by the caller, so it can outlive the client. Absent, nothing is capped. */
  postCap?: { rate: Map<string, number[]>; maxPosts: number; windowMs: number };
  /** Diagnostics from the best-effort paths. Default: dropped. */
  log?: RcLog;
  /** Headers to speak AS in this room, or undefined for the bot's own. Used by
   * `postReply`, `post`, `applyReactions` and `headersForRoom`. */
  identityForRoom?: (roomId: string) => Promise<RcHeaders | undefined>;
  /** Asked when `rooms.info` refuses: is this room nonetheless a DM? A yes is cached. */
  isDirectMessageFallback?: (roomId: string) => Promise<boolean>;
  /** Rewrites a reply before it is split (strip markers, pick a voice). `postReply` only. */
  outbound?: (text: string) => { text: string; voice?: PostVoice };
}

export interface RocketChatAuthStatus {
  ok: boolean;
  status: number;
  error?: string;
}

/** A posted message, enough to cite it back to a human. */
export interface PostedMessage {
  messageId: string;
  channel: string;
  /** Returned by Rocket.Chat for posts addressed by name, so a later post can
   * reach the same room without resolving its opaque id. */
  roomId?: string;
}

/** The fields of a Rocket.Chat message a caller reads (`chat.getMessage`). */
export interface RocketChatMessage {
  _id: string;
  rid: string;
  msg?: string;
  /** Thread root id; present only on a thread reply. */
  tmid?: string;
  /** ISO string from the REST API; `{ $date }` from some older servers. */
  ts: string | { $date: number };
  u: { _id: string; username: string; name?: string };
  /** Set on messages posted by bots and integrations. */
  bot?: unknown;
}

/** A file for `uploadToRoom`, already decoded and validated by the caller. */
export interface RoomFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/** One reaction to set or clear. */
export interface ReactionChange {
  emoji: string;
  shouldReact: boolean;
}

/** The result of a raw `post`: never thrown, so a best-effort caller can log it. */
export interface RawPostResult {
  ok: boolean;
  id?: string;
  detail?: string;
}

/** The `chat.postMessage` body, in the two shapes sent: by NAME (a channel or a
 * DM) or by ROOM ID (the only way to reach a specific thread). */
type PostBody =
  | { channel: string; text: string; alias?: string; avatar?: string }
  | { roomId: string; text: string; tmid?: string; alias?: string; avatar?: string };

const DEFAULT_TIMEOUT_MS = 15_000;

const errorText = (err: unknown) => (err as Error)?.message ?? String(err);

/**
 * One Rocket.Chat REST client, in two registers:
 *
 * - **Delivering** (`postToChannel`, `postToRoom`, `postAsMember`, `uploadToRoom`,
 *   `getMessage`): posts as the bot and THROWS on failure. For a scheduled job or
 *   a tool call, a message that silently vanished is worse than an error.
 * - **Replying** (`postReply`, `applyReactions`, `post`): posts as the room's
 *   identity and NEVER throws. For a live conversation, a failed post is logged
 *   and the conversation carries on.
 *
 * Room type (`isDirectMessage`), auth status and the reaction toggle (`react`)
 * serve both.
 */
export class RocketChatClient {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  private readonly maxMessageChars: number;
  private readonly config: RocketChatConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: RcLog;
  private readonly roomTypes = new Map<string, string>();

  /** `fetchImpl` is injectable for tests. */
  constructor(config: RocketChatConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.userId = config.userId;
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMessageChars = config.maxMessageChars ?? RC_MAX_MESSAGE_CHARS;
    this.fetchImpl = fetchImpl;
    this.log = config.log ?? (() => {});
  }

  /** The bot's own user id, so a caller can tell its posts from a human's. */
  get botUserId(): string {
    return this.userId;
  }

  /** The bot's own auth headers; `json` adds the content-type a POST needs. The
   * one place the credentials become headers. */
  botHeaders(json = true): RcHeaders {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      "X-Auth-Token": this.authToken,
      "X-User-Id": this.userId,
    };
  }

  /** Auth for one call into a room. The identity is a property of the ROOM, not
   * the call site, so an acknowledgement, the answer and a follow-up minutes later
   * share one voice. Falls back to the bot's own credentials. */
  async headersForRoom(roomId: string | undefined): Promise<RcHeaders> {
    if (!roomId || !this.config.identityForRoom) return this.botHeaders();
    try {
      return (await this.config.identityForRoom(roomId)) ?? this.botHeaders();
    } catch (err) {
      this.log(`identity headers for ${roomId} failed: ${errorText(err)}`);
      return this.botHeaders();
    }
  }

  /** A GET with this client's deadline, for reads the client has no method for
   * (an attachment, a history page). The caller picks the headers. */
  get(url: string, headers: RcHeaders, label: string): Promise<Response> {
    return fetchWithTimeout(url, { headers }, label, this.timeoutMs, this.fetchImpl);
  }

  /** Check the bot credential (`/api/v1/me`) without exposing it. Never throws. */
  async authStatus(): Promise<RocketChatAuthStatus> {
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/me`,
        { headers: this.botHeaders(false) },
        "Rocket.Chat /api/v1/me",
        this.timeoutMs,
        this.fetchImpl,
      );
      if (res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: `Rocket.Chat /api/v1/me answered ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: errorText(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Delivering: as the bot, throws on failure.
  // ---------------------------------------------------------------------------

  /**
   * Post BY NAME, so a caller never has to resolve an opaque room id first.
   * Rocket.Chat's `channel` field takes `#name` for a channel and `@name` for a
   * direct message, and opens the DM room if it does not exist yet, which is what
   * lets an unattended job reach a person who is not watching a channel.
   *
   * Over the size limit the text goes as several posts: the first finds the room,
   * the rest follow it there by id, in order.
   */
  async postToChannel(channel: string, text: string, voice?: PostVoice): Promise<PostedMessage> {
    const normalized = normalizeChannel(channel);
    const name = normalized.startsWith("@") ? normalized : `#${normalized}`;
    const extras = voiceFields(voice);
    const [first = "", ...rest] = splitForRc(text, this.maxMessageChars);
    let posted: PostedMessage;
    try {
      const sent = await this.send({ channel: name, text: first, ...extras }, name);
      posted = { messageId: sent.messageId, channel: name, ...(sent.roomId ? { roomId: sent.roomId } : {}) };
    } catch (err) {
      // A DM has no display name to fall back to, and an unknown @person is a
      // real error rather than a lookup problem.
      if (normalized.startsWith("@") || !isUnknownRoom(err)) throw err;
      const roomId = await this.resolveByDisplayName(normalized);
      if (!roomId) throw err;
      return this.postToRoom(roomId, text, undefined, voice);
    }
    for (const part of rest) {
      await this.send(
        posted.roomId ? { roomId: posted.roomId, text: part, ...extras } : { channel: name, text: part, ...extras },
        name,
      );
    }
    return posted;
  }

  /**
   * Find a room by its DISPLAY name, because a Rocket.Chat discussion does not
   * answer to the name a human knows it by.
   *
   * A discussion's `name` is generated (a random mixed-case id), and the title
   * everyone reads lives in `fname`. `chat.postMessage` resolves its `channel`
   * field against `name` and never against `fname`, so a post to a discussion by
   * its title fails with `[invalid-channel]` while the room is plainly visible.
   * Matching on `fname` lets callers keep using the only spelling a human knows,
   * even after case-folding.
   *
   * `rooms.get` returns the rooms this bot is SUBSCRIBED to, which needs no admin
   * permission and includes discussions. That is also the honest limit: a room the
   * bot has not joined is invisible here, and the caller gets the original
   * `[invalid-channel]`, because "not a member" is what actually needs fixing.
   *
   * Not cached: this path only runs after a post has already failed, so it is
   * rare, and a stale cached id would fail in a way that looks nothing like its
   * cause.
   */
  private async resolveByDisplayName(displayName: string): Promise<string | undefined> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/rooms.get`,
        { headers: this.botHeaders(false) },
        "Rocket.Chat rooms.get",
        this.timeoutMs,
        this.fetchImpl,
      );
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;

    const body = (await res.json().catch(() => undefined)) as
      | { update?: { _id?: string; name?: string; fname?: string }[] }
      | undefined;
    const wanted = displayName.toLowerCase();
    const hits = (body?.update ?? []).filter((room) => (room.fname ?? "").toLowerCase() === wanted && room._id);

    // Two rooms sharing a display name is not a coin toss. A message delivered
    // to the wrong room cannot be taken back, so an ambiguous lookup refuses.
    if (hits.length > 1) {
      const names = hits.map((r) => r.name ?? r._id).join(", ");
      throw new Error(
        `Rocket.Chat has ${hits.length} rooms displayed as "${displayName}" (${names}). ` +
          "Refusing to guess which one to post in — rename one, or route by its room id.",
      );
    }
    return hits[0]?._id;
  }

  /**
   * Post into a specific room, and optionally INSIDE a thread.
   *
   * `postToChannel` cannot do this: `channel` addresses a room by name, and a
   * thread is not a name. It is the id of the message the thread hangs off, which
   * only rides alongside a `roomId`. A missing `tmid` posts to the room root.
   * Every part of an oversized text lands in the same room and thread.
   */
  async postToRoom(roomId: string, text: string, tmid?: string, voice?: PostVoice): Promise<PostedMessage> {
    const label = tmid ? `room ${roomId} (thread ${tmid})` : `room ${roomId}`;
    const extras = voiceFields(voice);
    const body = (part: string): PostBody =>
      tmid ? { roomId, text: part, tmid, ...extras } : { roomId, text: part, ...extras };
    const [first = "", ...rest] = splitForRc(text, this.maxMessageChars);
    const posted = await this.send(body(first), label);
    for (const part of rest) await this.send(body(part), label);
    return { messageId: posted.messageId, channel: roomId, ...(posted.roomId ? { roomId: posted.roomId } : {}) };
  }

  /**
   * Post as a subscribed member (`chat.sendMessage`). When Rocket.Chat answers
   * `error-not-allowed` (a public channel the bot never joined), join it and try
   * again, and if that is still refused, fall back to `chat.postMessage`, which
   * needs no subscription.
   */
  async postAsMember(roomId: string, text: string, opts?: { tmid?: string; voice?: PostVoice }): Promise<PostedMessage> {
    const message: Record<string, unknown> = {
      rid: roomId,
      msg: text,
      ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      ...voiceFields(opts?.voice),
    };
    const label = opts?.tmid ? `room ${roomId} (thread ${opts.tmid})` : `room ${roomId}`;
    const sendOnce = async (): Promise<PostedMessage> => {
      const answer = (await this.call("chat.sendMessage", { body: JSON.stringify({ message }), json: true }, label)) as {
        message?: { _id?: string; rid?: string };
      };
      return {
        messageId: answer.message?._id ?? "",
        channel: roomId,
        ...(answer.message?.rid ? { roomId: answer.message.rid } : { roomId }),
      };
    };
    try {
      return await sendOnce();
    } catch (err) {
      if (!isNotAllowed(err)) throw err;
      if (await this.joinRoom(roomId)) {
        try {
          return await sendOnce();
        } catch (retryErr) {
          if (!isNotAllowed(retryErr)) throw retryErr;
        }
      }
      return this.postToRoom(roomId, text, opts?.tmid, opts?.voice);
    }
  }

  /**
   * Upload a file into a room as its own message, with `caption` as its text.
   * `rooms.upload` was removed in Rocket.Chat 7.0, so it is two calls:
   * `rooms.media` stores the file, `rooms.mediaConfirm` posts it. Both take a
   * room id.
   */
  async uploadToRoom(roomId: string, file: RoomFile, caption?: string): Promise<PostedMessage> {
    const label = `room ${roomId}`;
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.contentType }), file.name);
    const stored = (await this.call(`rooms.media/${encodeURIComponent(roomId)}`, { body: form }, label)) as {
      file?: { _id?: string };
    };
    const fileId = stored.file?._id;
    if (!fileId) throw new Error(`Rocket.Chat rooms.media for ${label} returned no file id; nothing was posted.`);
    const confirmed = (await this.call(
      `rooms.mediaConfirm/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}`,
      { body: JSON.stringify(caption ? { msg: caption } : {}), json: true },
      label,
    )) as { message?: { _id?: string } };
    return { messageId: confirmed.message?._id ?? "", channel: roomId, roomId };
  }

  /**
   * Read one message by id (`chat.getMessage`). Returns null when Rocket.Chat says
   * the message does not exist or is not visible to the bot, so a caller can
   * refuse with a named reason instead of catching. Other errors throw.
   */
  async getMessage(msgId: string): Promise<RocketChatMessage | null> {
    try {
      const answer = (await this.getJson(`chat.getMessage?msgId=${encodeURIComponent(msgId)}`, "chat.getMessage")) as {
        message?: RocketChatMessage;
      };
      return answer.message ?? null;
    } catch (err) {
      if (err instanceof RocketChatApiError && (err.status === 400 || err.status === 404)) return null;
      throw err;
    }
  }

  /**
   * Add or remove a reaction as the bot. `chat.react` toggles when `shouldReact`
   * is omitted; pass it to force add or remove. Never throws: the message already
   * landed, and a missing reaction is visible, not silent.
   */
  async react(messageId: string, emoji: string, shouldReact?: boolean): Promise<void> {
    const payload: Record<string, unknown> = { messageId, emoji };
    if (typeof shouldReact === "boolean") payload.shouldReact = shouldReact;
    try {
      await this.call("chat.react", { body: JSON.stringify(payload), json: true }, `message ${messageId}`);
    } catch {
      // Best-effort by contract.
    }
  }

  /** Join a public channel by room id. True on success, false when Rocket.Chat
   * refuses (a private group or a DM, where `channels.join` does not apply).
   * Never throws. */
  async joinRoom(roomId: string): Promise<boolean> {
    try {
      await this.call("channels.join", { body: JSON.stringify({ roomId }), json: true }, `room ${roomId}`);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Replying: as the room's identity, never throws.
  // ---------------------------------------------------------------------------

  /** POST a JSON body as the room's identity and pull the new message id out.
   * `roomId` is for bodies that name no room (`chat.react`). Resolves with
   * `ok: false` on a refusal; throws only on transport errors and the deadline. */
  async post(endpoint: string, body: unknown, roomId?: string): Promise<RawPostResult> {
    const headers = await this.headersForRoom(roomId ?? roomIdOfCall(body));
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/v1/${endpoint}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      `Rocket.Chat ${endpoint}`,
      this.timeoutMs,
      this.fetchImpl,
    );
    if (!res.ok) return { ok: false, detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
    const parsed = (await res.json()) as { message?: { _id?: string } };
    return { ok: true, id: parsed.message?._id };
  }

  /**
   * Post one message that already fits. Never throws.
   *
   * Two endpoints, in this order: `tshow` is a field of chat.sendMessage's message
   * object, and chat.postMessage 400s on it. So try chat.sendMessage when `tshow`
   * is wanted and ALWAYS fall back to plain chat.postMessage: losing `tshow` is
   * cosmetic, losing the reply is not. The payload shapes live in payload.ts.
   */
  private async postOne(roomId: string, text: string, tmid?: string, voice?: PostVoice): Promise<string | undefined> {
    try {
      const primary = postCall(roomId, text, tmid, this.config.threadShow ?? false, voice);
      const sent = await this.post(primary.endpoint, primary.body);
      if (sent.ok) return sent.id;
      if (primary.endpoint === "chat.postMessage") {
        this.log(`postMessage to ${roomId} failed: ${sent.detail}`);
        return undefined;
      }
      this.log(`${primary.endpoint} to ${roomId} failed: ${sent.detail} — falling back to chat.postMessage`);
      const fallback = fallbackCall(roomId, text, tmid, voice);
      const posted = await this.post(fallback.endpoint, fallback.body);
      if (!posted.ok) {
        this.log(`postMessage to ${roomId} failed: ${posted.detail}`);
        return undefined;
      }
      return posted.id;
    } catch (err) {
      this.log(`postMessage to ${roomId} threw: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * Post a reply, split to fit the size limit. Parts go out in order into the
   * same thread; returns the FIRST part's id, or undefined when it did not post.
   * Never throws.
   *
   * The post cap sits here so no path can forget it. `uncapped` is for control
   * replies only, so the cap can never take away the command that stops a loop.
   * `outbound` runs BEFORE the split, so a voice applies to every part.
   */
  async postReply(
    roomId: string,
    text: string,
    tmid?: string,
    opts: { uncapped?: boolean } = {},
  ): Promise<string | undefined> {
    const cap = this.config.postCap;
    if (cap && !opts.uncapped && !withinRate(cap.rate, `${roomId}:${tmid ?? "-"}`, Date.now(), cap.maxPosts, cap.windowMs)) {
      this.log(`post cap hit for ${roomId}:${tmid ?? "-"} — dropping a message to break a loop`);
      return undefined;
    }
    const { text: body, voice } = this.config.outbound ? this.config.outbound(text) : { text, voice: undefined };

    const parts = splitForRc(body, this.maxMessageChars);
    if (parts.length === 1) return this.postOne(roomId, parts[0]!, tmid, voice);

    this.log(`reply to ${roomId} is ${body.length} chars — posting as ${parts.length} messages`);
    let firstId: string | undefined;
    for (const [i, part] of parts.entries()) {
      const id = await this.postOne(roomId, part, tmid, voice);
      if (i === 0) firstId = id;
      // A partial answer beats a silent one: the remaining parts still go.
      if (!id) this.log(`part ${i + 1}/${parts.length} to ${roomId} did not post`);
    }
    return firstId;
  }

  /** Set or clear reactions as the room's identity, always stating
   * `shouldReact`. Never throws: a reaction is a courtesy and must never cost the
   * conversation it decorates. */
  async applyReactions(roomId: string, messageId: string, changes: ReadonlyArray<ReactionChange>): Promise<void> {
    for (const change of changes) {
      try {
        const call = reactCall(messageId, change.emoji, change.shouldReact);
        const res = await this.post(call.endpoint, call.body, roomId);
        if (!res.ok) this.log(`chat.react :${change.emoji}: on ${messageId} failed: ${res.detail}`);
      } catch (err) {
        this.log(`chat.react :${change.emoji}: on ${messageId} threw: ${errorText(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Room type.
  // ---------------------------------------------------------------------------

  /**
   * Is this room a direct message? Room ids are opaque, so the type comes from
   * `rooms.info`, cached because a room's type is stable. A refusal is not an
   * error: a DM the bot is not a member of refuses, so `isDirectMessageFallback`
   * is asked. When the answer is uncertain this returns false and caches nothing,
   * so the next call asks again.
   */
  async isDirectMessage(roomId: string): Promise<boolean> {
    const cached = this.roomTypes.get(roomId);
    if (cached !== undefined) return cached === "d";
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/rooms.info?roomId=${encodeURIComponent(roomId)}`,
        { headers: this.botHeaders(false) },
        "Rocket.Chat rooms.info",
        this.timeoutMs,
        this.fetchImpl,
      );
      if (res.ok) {
        const type = ((await res.json()) as { room?: { t?: string } }).room?.t ?? "";
        this.roomTypes.set(roomId, type);
        return type === "d";
      }
      if (this.config.isDirectMessageFallback && (await this.config.isDirectMessageFallback(roomId))) {
        this.roomTypes.set(roomId, "d");
        return true;
      }
      this.log(`rooms.info ${roomId} failed: ${res.status}`);
    } catch (err) {
      this.log(`rooms.info ${roomId} threw: ${errorText(err)}`);
    }
    return false;
  }

  /** The type `isDirectMessage` learned (`c`, `p`, `d`, …); never a call of its own. */
  cachedRoomType(roomId: string): string | undefined {
    return this.roomTypes.get(roomId);
  }

  // ---------------------------------------------------------------------------
  // Transport.
  // ---------------------------------------------------------------------------

  /** A GET to the REST API that throws a typed error on a non-2xx. */
  private async getJson(path: string, endpoint: string): Promise<unknown> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/v1/${path}`,
      { headers: this.botHeaders(false) },
      `Rocket.Chat ${endpoint}`,
      this.timeoutMs,
      this.fetchImpl,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new RocketChatApiError(res.status, endpoint, parseErrorBody(text)?.error, text);
    }
    return res.json();
  }

  /** A POST to the REST API as the bot that throws on a non-2xx and on
   * Rocket.Chat's `success: false`. */
  private async call(path: string, init: { body: BodyInit; json?: boolean }, _label: string): Promise<unknown> {
    const route = path.split("/")[0] ?? path;
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/v1/${path}`,
      { method: "POST", headers: this.botHeaders(init.json ?? false), body: init.body },
      `Rocket.Chat ${route}`,
      this.timeoutMs,
      this.fetchImpl,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new RocketChatApiError(res.status, route, parseErrorBody(text)?.error, text);
    }
    const answer = (await res.json()) as RocketChatErrorBody;
    if (answer.success === false) {
      throw new RocketChatApiError(200, route, answer.error, answer.error ?? "unknown error");
    }
    return answer;
  }

  /**
   * The delivering `chat.postMessage`, and every way it can fail to deliver.
   * `label` names the target back to a caller who has to fix it; it never appears
   * in the request.
   */
  private async send(body: PostBody, label: string): Promise<{ messageId: string; roomId?: string }> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/v1/chat.postMessage`,
      { method: "POST", headers: this.botHeaders(), body: JSON.stringify(body) },
      "Rocket.Chat chat.postMessage",
      this.timeoutMs,
      this.fetchImpl,
    );

    if (!res.ok) {
      const text = await res.text();
      const parsed = parseErrorBody(text);
      // A 400 is how Rocket.Chat answers "no such room". A 401, a 403 or a 5xx
      // that happens to quote the same token is an auth or availability failure
      // and must stay reportable as itself, so the status gates the
      // classification too.
      throw new RocketChatPostError(`Rocket.Chat chat.postMessage to ${label} failed: ${res.status} ${text.slice(0, 300)}`, {
        unknownRoom: res.status === 400 && namesUnknownRoom(parsed),
        status: res.status,
        rcError: parsed?.errorType ?? parsed?.error,
      });
    }
    // Rocket.Chat answers 200 with `success: false` for a channel the bot cannot
    // see, so the status code alone is not proof of delivery.
    const answer = (await res.json()) as RocketChatErrorBody & { message?: { _id?: string; rid?: string } };
    if (answer.success === false) {
      throw new RocketChatPostError(
        `Rocket.Chat refused the post to ${label}: ${answer.error ?? "unknown error"}. ` +
          "The bot may not be a member of that room.",
        { unknownRoom: namesUnknownRoom(answer), status: 200, rcError: answer.errorType ?? answer.error },
      );
    }
    return {
      messageId: answer.message?._id ?? "",
      ...(answer.message?.rid ? { roomId: answer.message.rid } : {}),
    };
  }
}

/**
 * May this failure be retried as a display-name lookup? Only a post Rocket.Chat
 * itself classified as an unknown room. A timeout, a network error, a 401, a 403
 * and a 5xx keep their identity and are rethrown: retried down the lookup path,
 * they could surface as an unrelated ambiguous-room error, or deliver by id a
 * message the first failure should have stopped.
 */
function isUnknownRoom(err: unknown): boolean {
  return err instanceof RocketChatPostError && err.unknownRoom;
}

/** Rocket.Chat refused because the bot is not a member of the room. */
function isNotAllowed(err: unknown): boolean {
  return err instanceof RocketChatApiError && err.rcError === "error-not-allowed";
}
