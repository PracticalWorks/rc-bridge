
// Where a reply belongs, and which messages make a later threaded reply "ours".
// Kept apart from main.ts so it can be tested without booting the bridge:
// main.ts reads required env at import time and exits when it is missing.
//
// The rule this file encodes: ONE request, ONE thread. Everything the bridge
// says about a message — the ack, the answer, an error, and a result a plugin
// delivers minutes later — goes to the same place, so a single exchange is
// never split across the channel and a thread nobody is watching.

/** The webhook fields that decide where a reply goes. */
export interface ThreadablePayload {
  /** The incoming message's own id (RC's "Message Sent" webhook includes it). */
  message_id?: string;
  /** The thread root — set by RC only when the incoming message IS a threaded reply. */
  tmid?: string;
}

/**
 * The agent conversation a message belongs to.
 *
 * The rule is "did a human put this in a thread", not "is this a DM".
 *
 * A `tmid` is the human saying, explicitly, that this is a separate topic — so
 * it gets its own conversation wherever it happens, a DM included. Collapsing a
 * DM's threads onto the room key would share one agent context, so topics bleed
 * together, and one lock, so a turn in one thread pushes back a message in another.
 *
 * DM messages often arrive top-level, though, and keying THOSE per thread would
 * mint a new conversation on every message and lose the history each time. That
 * applies to a message with no `tmid`, which is the case below it.
 *
 * So: an explicit thread anywhere → its own conversation. Otherwise a DM stays
 * one continuous conversation per room. Falls back to the room key when RC
 * supplied no message id at all (same case where replies go to the room root).
 *
 * "Continuous" is bounded by `epoch`: the room key carries the
 * current conversation epoch — a daily boundary, bumped by `/new` — so a room's
 * agent context cannot grow without limit (see conversation-epochs.ts). Thread
 * keys never take the epoch: a thread already starts fresh.
 */
export function conversationKey(
  roomId: string,
  thread: string | undefined,
  isDM: boolean,
  tmid?: string,
  epoch?: string,
): string {
  if (tmid) return `rc:${roomId}:${tmid}`;
  if (isDM || !thread) return epoch ? `rc:${roomId}:${epoch}` : `rc:${roomId}`;
  return `rc:${roomId}:${thread}`;
}

/** The webhook fields the context header is built from. */
export interface HeaderPayload {
  channel_name?: string;
  channel_id?: string;
  user_name?: string;
  message_id?: string;
}

/**
 * One line of situational context prefixed to every turn, so the agent knows
 * WHERE it's standing (which channel, and so which kind of work) and WHO is
 * asking (the human to attribute work to). Without it
 * the request body is bare message text and the agent is channel-blind.
 *
 * It also carries the ADDRESS — `room=` and, inside a thread, `thread=`. That is
 * what lets a turn schedule something that speaks back later: a scheduled run
 * wakes with no conversation and no platform (Rocket.Chat is not one of the
 * gateway's delivery adapters), so its only way home is a tool that posts to an
 * explicit room and thread. The agent cannot pass an address it was never told,
 * and a reminder that cannot name its own thread lands somewhere else, or nowhere.
 *
 * `thread` is the resolved reply target, not the raw `tmid`: a top-level message
 * threads on its own id, and that is exactly where the answer belongs.
 */
export function contextHeader(payload: HeaderPayload, isDM: boolean, thread?: string): string {
  const where = isDM ? "DM" : `#${payload.channel_name ?? payload.channel_id ?? "unknown"}`;
  const who = payload.user_name ? ` · from @${payload.user_name}` : "";
  const room = payload.channel_id ? ` · room=${payload.channel_id}` : "";
  const inThread = thread ? ` · thread=${thread}` : "";
  // Contract: a caller that acts on this message later re-reads it by THIS id.
  const msg = payload.message_id ? ` · msg=${payload.message_id}` : "";
  return `[${where}${who}${room}${inThread}${msg}]`;
}

/** The thread a reply to this message belongs in.
 *
 * Already in a thread → that same thread. Otherwise → a new thread rooted on the
 * message we're answering, so the human's request is the thing everything hangs
 * off. `undefined` only when RC gave us no message id at all; the caller then
 * posts to the room root rather than dropping the reply.
 *
 * This always resolves to a thread ROOT, never to a message sitting inside a
 * thread — Rocket.Chat would treat the latter as the root of a NEW thread and
 * split the conversation all over again. */
export function threadFor(payload: ThreadablePayload): string | undefined {
  return payload.tmid ?? payload.message_id;
}

/** Inputs to the thread-root hydration decision. */
export interface RootHydrationContext {
  /** Set only when the message IS a reply inside a thread — the root's id. */
  tmid?: string;
  isDM: boolean;
  respondToAll: boolean;
  /** Has a turn already gone to the agent on this conversation? If so the gateway
   * is chaining it and the history is already there. */
  conversationStarted: boolean;
}

/** Does this turn need the thread's root message pulled in?
 *
 * Yes exactly when the agent is being pulled into a thread whose earlier messages
 * it never received: a threaded reply, in a channel, on a conversation that has
 * had no turn yet. That's the case where a human posted the substance — a link,
 * a quote, a paste — as the root WITHOUT mentioning us, so the addressing gate
 * dropped it, and then asked us to act on it in a reply. The agent got the verb and
 * none of the noun.
 *
 * No once the conversation is started, so an ongoing thread doesn't re-read its
 * root on every turn.
 *
 * The real question is narrower than "is this a DM": did the ROOT
 * itself land in THIS conversation? If it did, re-reading it would just say the
 * same thing twice.
 *
 *  - In a channel under RESPOND_TO_ALL it did. Every message is relayed, and the
 *    root's own key IS this thread's key — a top-level message keys on its own
 *    id, which is exactly the `tmid` its replies carry. So: no.
 *  - In a DM it did NOT, now that a DM thread has its own conversation. The root
 *    was a top-level DM message, which still keys on the ROOM. The thread starts
 *    empty, so a reply in it reaches the agent as a bare "do that" with the subject
 *    sitting in a conversation it cannot see. So: yes, hydrate, DM or not. */
export function shouldHydrateRoot(ctx: RootHydrationContext): boolean {
  if (!ctx.tmid) return false;
  if (ctx.conversationStarted) return false;
  if (ctx.respondToAll && !ctx.isDM) return false;
  return true;
}

/** How many ids a room remembers for the addressing gate. */
export const MAX_TRACKED_IDS = 50;

/** Remember an id that makes a later threaded reply count as addressed to us:
 * a message the agent posted, or a thread it posted into. Bounded, oldest evicted
 * first — and re-remembering refreshes recency, so a thread that's still active
 * doesn't age out from under an ongoing conversation. */
export function remember(ids: Set<string>, id: string | undefined, max = MAX_TRACKED_IDS): void {
  if (!id) return;
  ids.delete(id); // a Set keeps FIRST-insert order, so delete+add is what refreshes it
  ids.add(id);
  while (ids.size > max) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

// --- Surviving a restart -----------------------------------------
// The ids above are what let a human continue a thread WITHOUT retyping the
// @mention. Held only in memory, they would die on every restart — and because
// an unaddressed message produces no output at all, the room would just go
// quiet and read as "the agent is broken". So the set is snapshotted to disk.

/** How many rooms a snapshot keeps. A backstop, not a real limit — a workspace
 * has tens of rooms, and each one's ids are already capped. */
export const MAX_TRACKED_ROOMS = 500;

/** The room state the addressing gate depends on.
 *
 * `threadOwners` is what makes the gate fail CLOSED: thread id → the
 * lowercased username of the human whose message started the exchange. Only that
 * person gets answered without an @mention. */
export interface RoomEngagement {
  engagedIds: Set<string>;
  threadOwners: Map<string, string>;
}

/** Record who owns a thread, first writer wins.
 *
 * First writer, because the owner is whoever's request the agent engaged with — a
 * later participant does not inherit the right to drive it silently. Bounded
 * alongside the id set so a busy workspace can't grow it forever. */
export function rememberOwner(
  owners: Map<string, string>,
  threadId: string | undefined,
  username: string | undefined,
  max = MAX_TRACKED_IDS,
): void {
  if (!threadId || !username || owners.has(threadId)) return;
  owners.set(threadId, username.toLowerCase());
  while (owners.size > max) {
    const oldest = owners.keys().next().value;
    if (oldest === undefined) break;
    owners.delete(oldest);
  }
}

/** Inputs to the addressing decision. */
export interface AddressingContext {
  mentioned: boolean;
  isDM: boolean;
  /** Thread root, when the message is a threaded reply. */
  tmid?: string;
  /** Who sent this message. */
  sender?: string;
  /** thread id → owning human, from RoomEngagement. */
  threadOwners: Map<string, string>;
  /** Did WE open this thread by naming this sender? See `rootInvites` — the
   * announcement case, where there is no owner to match against because the
   * thread never came through the bridge at all. */
  invited?: boolean;
  /** Is the thread rooted on a message WE posted? See `rootIsOurs` — the same
   * announcement case as `invited`, for the announcements that named nobody. */
  ourRoot?: boolean;
  /** Does the thread's ROOT @mention us? See `rootAddressesUs` — the request
   * case, where a human opened the thread by tagging us and the answer comes
   * from a different human. */
  rootAddressesUs?: boolean;
}

/**
 * Should the bridge engage with this message?
 *
 * The test is WHO sent it, not only WHERE it is. A rule of "any message in a
 * thread I've replied in" gives a turn to any account posting into an engaged
 * thread, so another bot's announcement there reads as a request, and a loop
 * between the two can fill the room.
 *
 * So: a mention always works — that is how a human reaches us on purpose. A DM is
 * always us. Otherwise the ONLY silent path is the human who started the thread
 * continuing their own conversation. Every other sender, bot or human, known or
 * unknown, has to @mention us. Unknown senders therefore fail closed, which is
 * the property a denylist can never give: a denylist is empty until someone
 * remembers to fill it.
 *
 * Three widenings, each for a thread whose first message settles who it is for:
 *
 *  - `invited`: a thread WE opened by naming someone. Ownership is only recorded
 *    when the bridge engages, so a thread rooted on an ANNOUNCEMENT (posted to
 *    Rocket.Chat's REST API by some other process, never through this one) has
 *    no owner, and the person the announcement asked to decide would be dropped
 *    for not retyping the mention. An invitation counts as ownership until the
 *    real owner is recorded. A room tag (`@all`, `@here`) in a root we wrote
 *    invites every human in the room; see `rootInvites`.
 *  - `ourRoot`: a thread WE rooted engages its first replier, for announcements
 *    addressed to whoever is reading. An announcement is a question; a reply in
 *    its thread is an answer to it. Bounded by the owner map: only while the
 *    thread is UNCLAIMED. The first human in becomes its owner (first writer
 *    wins, recorded by the caller), and from then on everyone else is back to
 *    needing an @mention, so one announcement hands out one seat.
 *  - `rootAddressesUs`: a thread a human rooted BY TAGGING US. The agent answers
 *    in the thread, often with a question, and whoever answers it is talking to
 *    us, not only the person who opened it. The tag is a fact about the thread
 *    that Rocket.Chat already stores, needs no state of ours to stay true, and
 *    reads the same way to a human looking at the room.
 *
 * None of these lets a loop back in: a thread the bot did not root and that
 * never tagged us fails all three, and bots are dropped several guards before
 * this function is reached — by `payload.bot`, by the account denylist, and by
 * any plugin's `isOwnVoice`. What widens here is which HUMANS may answer.
 */
export function shouldEngage(ctx: AddressingContext): boolean {
  if (ctx.mentioned || ctx.isDM) return true;
  if (!ctx.tmid || !ctx.sender) return false;
  if (ctx.threadOwners.get(ctx.tmid) === ctx.sender.toLowerCase()) return true;
  if (ctx.invited === true) return true;
  if (ctx.rootAddressesUs === true) return true;
  return ctx.ourRoot === true && !ctx.threadOwners.has(ctx.tmid);
}

/** Mentions that address a ROOM rather than a person. In a root a HUMAN wrote
 * they never put US in the conversation (`rootAddressesUs` — a threaded room
 * broadcast must not hand us every reply in it). In a root WE wrote they do the
 * opposite: tagging the room is us inviting everyone in it (`rootInvites`). */
const ROOM_MENTIONS = new Set(["all", "here", "channel"]);

/** The bit of a thread root that decides whether it invited its replies. */
export interface ThreadRoot {
  /** The root's author, as RC reports it. */
  u?: { _id?: string; username?: string };
  /** RC's parsed mentions. Absent on older/edited messages, hence the text fallback. */
  mentions?: Array<{ _id?: string; username?: string }>;
  /** The raw text, used only when `mentions` is missing. */
  msg?: string;
}

/** Our own identity, for deciding whether a root is ours. */
export interface BotIdentity {
  userId: string;
  /** Lowercased. */
  username: string;
  /** The OTHER usernames we answer to, lowercased: accounts a plugin speaks
   * through. The agent is one brain behind several faces, and someone writing
   * "@concierge, the heater is out" is addressing us exactly as much as someone
   * writing "@bot". Optional, so a caller that only cares about the bot's own
   * account can leave it out. */
  faces?: readonly string[];
}

/** Every username we answer to: our own, plus any other faces, deduped. */
export function botFaces(us: BotIdentity): readonly string[] {
  return [...new Set([us.username, ...(us.faces ?? [])].map((f) => f.toLowerCase()))];
}

/** Escape a username before interpolating it into a mention pattern.
 *
 * Not paranoia: a username like `help.desk` is legal, and an unescaped `.`
 * matches any character — so `@helpxdesk` would read as a mention of it. */
function escapeForMention(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this text @mention any of our faces? */
export function mentionsUs(text: string, us: BotIdentity): boolean {
  return botFaces(us).some((face) => new RegExp(`@${escapeForMention(face)}\\b`, "i").test(text));
}

/** Strip the @mention of any of our faces out of a prompt, so the model gets the
 * request rather than the addressing. */
export function stripOurMentions(text: string, us: BotIdentity): string {
  return botFaces(us)
    .reduce((acc, face) => acc.replace(new RegExp(`@${escapeForMention(face)}\\b`, "gi"), ""), text)
    .trim();
}

/**
 * Did WE post the message this thread hangs off?
 *
 * The bridge threads its own replies onto the HUMAN's message, so a root we
 * authored is, in practice, exactly one thing: an announcement, posted to
 * Rocket.Chat's REST API by another process, never through this one. That is
 * why it needs a rule of its own; see `shouldEngage`.
 *
 * Matches on either id or username, because RC reports the author both ways and
 * a bridge configured with one but not the other must not silently stop
 * recognising its own posts.
 *
 * The username side reads `botFaces`, not `us.username` alone. One brain wears
 * several faces, and a post by any of them is a post by us in every sense that
 * matters here — the mention gate already treats those names as ours. Compared
 * against the single configured username, a thread rooted on a scheduled post
 * by another face would never be "ours", and every reply in it that had not
 * retyped an @mention would be dropped.
 */
export function rootIsOurs(root: ThreadRoot | undefined, us: BotIdentity): boolean {
  if (!root) return false;
  if (root.u?._id === us.userId) return true;
  const author = root.u?.username?.toLowerCase();
  return author !== undefined && botFaces(us).includes(author);
}

/**
 * Did we open this thread by naming this person?
 *
 * True only when BOTH hold: the root is a message we posted, and it @mentions
 * the sender — by name, or by tagging the whole room. `@all` / `@here` /
 * `@channel` in OUR root invite everyone: a roll call that opens with "@all —
 * one line each" means it, and must not refuse the second human to answer
 * because the first claimed the thread. A room tag we chose to write is an open
 * mic on purpose; when we don't want one, we don't tag the room. The flood
 * properties hold anyway — bots never reach this function (`payload.bot`, the
 * denylist and `isOwnVoice` all return earlier), and the per-thread post cap
 * bounds what any conversation can make us emit.
 *
 * Prefers RC's parsed `mentions` array and falls back to scanning the text,
 * because a message RC never re-parsed (or that we posted before it indexed
 * mentions) still has the `@name` in its body. The fallback is a word-boundary
 * match, so `@mar` does not invite `@maria`.
 */
export function rootInvites(root: ThreadRoot | undefined, us: BotIdentity, sender: string | undefined): boolean {
  if (!root || !sender) return false;
  if (!rootIsOurs(root, us)) return false;

  const who = sender.toLowerCase();
  if (ROOM_MENTIONS.has(who)) return false;

  const mentioned = (root.mentions ?? [])
    .map((m) => m.username?.toLowerCase())
    .filter((n): n is string => Boolean(n));
  if (mentioned.some((n) => ROOM_MENTIONS.has(n))) return true;
  const named = mentioned.filter((n) => !ROOM_MENTIONS.has(n));
  if (named.length > 0) return named.includes(who);

  // No parsed mentions — read the text instead. The room tags first, then the
  // sender's own name. Escaped, because a username is interpolated into a
  // pattern here and RC does not promise it is word-safe.
  const text = root.msg ?? "";
  if ([...ROOM_MENTIONS].some((tag) => new RegExp(`@${tag}\\b`, "i").test(text))) return true;
  const escaped = who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}\\b`, "i").test(text);
}

/**
 * Did the thread's root address US by name?
 *
 * The counterpart to `rootInvites`: that one asks whether a root WE wrote named
 * the sender, this one asks whether a root THEY wrote named us. A human opening
 * a thread with "@bot do X" has put us in the conversation, so a reply into
 * that thread is addressed to us whoever sends it — see `shouldEngage` for why
 * that is the rule and what it does not reopen.
 *
 * `@all` / `@here` / `@channel` never count. They address the room, and a room
 * broadcast that happened to be threaded would otherwise hand us every reply in
 * it — the same trap `rootInvites` avoids, from the other direction.
 *
 * ANY of our faces counts, not just the bot's own account (`botFaces`): "you may
 * answer a thread that tagged one face, but tagging another never reaches us" is
 * not a rule anyone could hold in their head.
 *
 * Matches on id or username for the reason `rootIsOurs` does: RC reports a
 * mention both ways, and a bridge configured with one but not the other must not
 * silently stop recognising when it was tagged. Prefers RC's parsed `mentions`
 * and falls back to the raw text, because a message RC never re-parsed still
 * carries the `@name` in its body; the fallback is word-bounded, so `@bo` does
 * not read as `@bot`.
 *
 * This widens who may ANSWER, never who may speak AS us. A message authored by
 * another face or any other bot is dropped by the loop guards at the top of
 * `handleMessage` — `payload.bot`, our own id and username, `isOwnVoice`, and
 * the bot denylist — all of which return long before this function is
 * consulted. The faces can be talked TO here; they still cannot talk to each
 * other.
 */
export function rootAddressesUs(root: ThreadRoot | undefined, us: BotIdentity): boolean {
  if (!root) return false;

  const faces = new Set(botFaces(us));
  const named = (root.mentions ?? []).filter(
    (m) => !(m.username && ROOM_MENTIONS.has(m.username.toLowerCase())),
  );
  if (named.length > 0) {
    return named.some((m) => m._id === us.userId || faces.has((m.username ?? "").toLowerCase()));
  }

  return mentionsUs(root.msg ?? "", us);
}

/** A room's on-disk record. `ids` is OLDEST FIRST — order is the whole point,
 * since `remember` evicts by it and a snapshot that shuffled would quietly change
 * which threads get forgotten first. `owners` is thread id → owning human. */
export interface RoomSnapshot {
  ids: string[];
  owners?: Record<string, string>;
}

/** The on-disk shape. The bare-array form is what earlier builds wrote (ids
 * only); it is still read, so a deploy doesn't drop everyone's engaged threads. */
export type EngagementSnapshot = Record<string, string[] | RoomSnapshot>;

/** Rooms → a plain JSON object. Rooms that remember nothing are dropped rather
 * than written as empty arrays. */
export function serializeEngagement(
  rooms: Map<string, RoomEngagement>,
  maxRooms = MAX_TRACKED_ROOMS,
): EngagementSnapshot {
  const out: EngagementSnapshot = {};
  let kept = 0;
  for (const [roomId, room] of rooms) {
    if (room.engagedIds.size === 0) continue;
    if (kept++ >= maxRooms) break;
    const record: RoomSnapshot = { ids: [...room.engagedIds] };
    if (room.threadOwners.size) record.owners = Object.fromEntries(room.threadOwners);
    out[roomId] = record;
  }
  return out;
}

/** A snapshot → rooms, defensively. Anything malformed is skipped rather than
 * thrown: a corrupt state file must cost us engagement memory, never the boot.
 * Re-applies the per-room cap, so a file hand-edited (or written by an older
 * build with a bigger cap) can't reintroduce unbounded growth. */
export function deserializeEngagement(raw: unknown, max = MAX_TRACKED_IDS): Map<string, RoomEngagement> {
  const rooms = new Map<string, RoomEngagement>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rooms;
  for (const [roomId, record] of Object.entries(raw as Record<string, unknown>)) {
    if (!roomId || !record) continue;
    // Two shapes: the bare array earlier builds wrote, and the {ids, owners}
    // record we write now. A file from before this change loses no engaged
    // threads — it simply has no owners yet, so those threads need one @mention
    // to re-establish who drives them.
    const ids = Array.isArray(record)
      ? record
      : typeof record === "object" && Array.isArray((record as RoomSnapshot).ids)
        ? (record as RoomSnapshot).ids
        : null;
    if (!ids) continue;

    const engagedIds = new Set<string>();
    for (const id of ids) {
      if (typeof id === "string") remember(engagedIds, id, max);
    }
    if (!engagedIds.size) continue;

    const threadOwners = new Map<string, string>();
    const rawOwners = Array.isArray(record) ? undefined : (record as RoomSnapshot).owners;
    if (rawOwners && typeof rawOwners === "object" && !Array.isArray(rawOwners)) {
      for (const [threadId, owner] of Object.entries(rawOwners)) {
        // Only for threads we still remember — otherwise an owner map could
        // outlive its ids and grow past the cap they're bounded by.
        if (typeof owner === "string" && engagedIds.has(threadId)) {
          rememberOwner(threadOwners, threadId, owner, max);
        }
      }
    }
    rooms.set(roomId, { engagedIds, threadOwners });
  }
  return rooms;
}

// --- Saying something when we ignore someone ----------------------
// An unaddressed message produces NO output at all, so "the agent isn't
// listening" and "the agent is down" look identical from the room. So we speak
// up — but carefully: a channel where every human message drew "I only answer
// @mentions" would be far worse than silence.
//
// Loops are bounded elsewhere: the client's post cap (`withinRate`) counts what
// the bridge EMITS per thread, never how long a person may talk. If a bot ever
// reaches that cap, that is a hole in the addressing gate — fix it there, and do
// not add a limit on how much a person may say.

/** How long before the same thread may be nudged again. */
export const NUDGE_COOLDOWN_MS = 30 * 60_000;

/** Is this dropped message worth a nudge?
 *
 * Only when the sender had real reason to expect an answer: a threaded reply,
 * inside a thread the agent has actually posted in. Everything else is silent.
 *
 * Asking "is this a threaded reply, or an upload?" would ask whether a message
 * was aimed at SOMETHING, never at US: a file dropped in a channel for other
 * humans, or two people threading a conversation the agent had no part in, would
 * draw an interjection nobody invited.
 *
 * Requiring `tmid` also keeps the throttle honest: with no `tmid` the caller's
 * cooldown key falls back to the message's own id, unique every time, so the
 * per-thread throttle would never match.
 *
 * A non-owner posting into an agent thread still gets nudged: they had every
 * reason to expect an answer, so silence would read as "the agent is down"
 * rather than "the agent isn't listening". */
export function worthNudging(payload: ThreadablePayload, room: RoomEngagement): boolean {
  return !!payload.tmid && room.engagedIds.has(payload.tmid);
}

/** Rate-limit gate: at most one nudge per thread per cooldown. Mutates
 * `lastNudges` on success so the caller can't forget to. */
export function nudgeAllowed(
  lastNudges: Map<string, number>,
  key: string,
  now: number,
  cooldownMs = NUDGE_COOLDOWN_MS,
): boolean {
  const last = lastNudges.get(key);
  if (last !== undefined && now - last < cooldownMs) return false;
  lastNudges.set(key, now);
  // Bounded like everything else here — a busy workspace shouldn't accumulate a
  // key per thread forever.
  if (lastNudges.size > MAX_TRACKED_IDS * 4) {
    const oldest = lastNudges.keys().next().value;
    if (oldest !== undefined) lastNudges.delete(oldest);
  }
  return true;
}
