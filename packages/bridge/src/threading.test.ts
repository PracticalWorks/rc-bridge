import * as threading from "./threading.js";
import { describe, expect, it } from "vitest";
import {
  botFaces,
  contextHeader,
  conversationKey,
  deserializeEngagement,
  MAX_TRACKED_IDS,
  mentionsUs,
  remember,
  nudgeAllowed,
  rememberOwner,
  rootAddressesUs,
  rootInvites,
  rootIsOurs,
  stripOurMentions,
  type RoomEngagement,
  serializeEngagement,
  shouldEngage,
  shouldHydrateRoot,
  threadFor,
  worthNudging,
} from "./threading.js";
import { DEFAULT_LOOP_WINDOW_MS, DEFAULT_MAX_POSTS_PER_THREAD } from "@practicalworks/rc-client";

/** Build a rooms map the way the bridge state holds one. */
const roomsOf = (spec: Record<string, string[]>, owners: Record<string, Record<string, string>> = {}) =>
  new Map(
    Object.entries(spec).map(([id, ids]) => [
      id,
      { engagedIds: new Set(ids), threadOwners: new Map(Object.entries(owners[id] ?? {})) },
    ]),
  );

describe("threadFor", () => {
  it("starts a thread on the message it is answering", () => {
    // A top-level ask must not get a room-root reply while a later result threads
    // onto the ask, or one exchange lives in two places.
    expect(threadFor({ message_id: "ASK1" })).toBe("ASK1");
  });

  it("stays in the thread the human is already in", () => {
    expect(threadFor({ message_id: "REPLY2", tmid: "ROOT1" })).toBe("ROOT1");
  });

  it("never roots a new thread on a message inside a thread", () => {
    // Answering with the reply's own id would fork a second thread off the first.
    expect(threadFor({ message_id: "REPLY2", tmid: "ROOT1" })).not.toBe("REPLY2");
  });

  it("falls back to the room root when RC gave us no id", () => {
    expect(threadFor({})).toBeUndefined();
  });
});

describe("remember", () => {
  it("ignores an id we never got (a failed RC post returns undefined)", () => {
    const ids = new Set<string>();
    remember(ids, undefined);
    expect(ids.size).toBe(0);
  });

  it("keeps both the message posted and the thread it went into", () => {
    const ids = new Set<string>();
    remember(ids, "BOT_MSG");
    remember(ids, "THREAD_ROOT");
    expect([...ids]).toEqual(["BOT_MSG", "THREAD_ROOT"]);
  });

  it("bounds itself, dropping the oldest first", () => {
    const ids = new Set<string>();
    for (let i = 0; i < MAX_TRACKED_IDS + 5; i++) remember(ids, `m${i}`);
    expect(ids.size).toBe(MAX_TRACKED_IDS);
    expect(ids.has("m0")).toBe(false);
    expect(ids.has(`m${MAX_TRACKED_IDS + 4}`)).toBe(true);
  });

  it("refreshes a thread that is still active so it does not age out", () => {
    const ids = new Set<string>();
    remember(ids, "LIVE_THREAD", 3);
    remember(ids, "a", 3);
    remember(ids, "LIVE_THREAD", 3); // the agent posts into it again
    remember(ids, "b", 3);
    remember(ids, "c", 3); // pushes past the cap
    expect(ids.has("LIVE_THREAD")).toBe(true);
    expect(ids.has("a")).toBe(false); // the genuinely stale one went instead
  });
});

describe("conversationKey", () => {
  it("gives each channel thread its own conversation", () => {
    expect(conversationKey("ROOM1", "msgA", false)).toBe("rc:ROOM1:msgA");
    expect(conversationKey("ROOM1", "msgB", false)).toBe("rc:ROOM1:msgB");
    expect(conversationKey("ROOM2", "msgA", false)).toBe("rc:ROOM2:msgA");
  });

  it("keeps top-level DM messages as ONE continuous conversation", () => {
    // DM messages often arrive top-level; per-thread keying there would reset
    // The agent's memory on every message. This is the case that reasoning is about,
    // and it is unchanged.
    expect(conversationKey("DM1", "msgA", true)).toBe("rc:DM1");
    expect(conversationKey("DM1", "msgB", true)).toBe("rc:DM1");
  });

  it("gives each DM THREAD its own conversation", () => {
    // A tmid is the human saying "separate topic". Every DM thread used to
    // collapse onto the room key: one shared context, and one lock, so a turn in
    // one thread pushed back a message in another.
    expect(conversationKey("DM1", "topicA", true, "topicA")).toBe("rc:DM1:topicA");
    expect(conversationKey("DM1", "topicB", true, "topicB")).toBe("rc:DM1:topicB");
    // …and they are genuinely distinct, which is the whole point.
    expect(conversationKey("DM1", "topicA", true, "topicA")).not.toBe(
      conversationKey("DM1", "topicB", true, "topicB"),
    );
  });

  it("leaves channel keys exactly as they were", () => {
    // A channel reply already keyed on its tmid, because `thread` IS the tmid
    // there. Passing it explicitly must not change a single key.
    expect(conversationKey("ROOM1", "root1", false, "root1")).toBe("rc:ROOM1:root1");
    expect(conversationKey("ROOM1", "ownId", false, undefined)).toBe("rc:ROOM1:ownId");
  });

  it("falls back to the room when RC supplied no message id", () => {
    expect(conversationKey("ROOM1", undefined, false)).toBe("rc:ROOM1");
  });
});

describe("contextHeader", () => {
  it("names the message itself, so a seed approval can cite it", () => {
    expect(
      contextHeader({ channel_name: "general", channel_id: "R1", user_name: "maria", message_id: "M9" }, false, "T1"),
    ).toBe("[#general · from @maria · room=R1 · thread=T1 · msg=M9]");
  });

  it("names the channel and the requester", () => {
    expect(contextHeader({ channel_name: "general", channel_id: "R1", user_name: "sam" }, false)).toBe(
      "[#general · from @sam · room=R1]",
    );
  });

  it("labels a DM and tolerates missing fields", () => {
    expect(contextHeader({ user_name: "sam" }, true)).toBe("[DM · from @sam]");
    expect(contextHeader({ channel_id: "R1" }, false)).toBe("[#R1 · room=R1]");
  });

  // The address a scheduled run needs to speak back here. Without it the agent cannot
  // pass a room or thread to a posting tool, and a reminder lands nowhere.
  it("carries the room and thread ids so a reminder can be addressed home", () => {
    expect(contextHeader({ channel_id: "R1", user_name: "maria" }, true, "T1")).toBe(
      "[DM · from @maria · room=R1 · thread=T1]",
    );
  });

  it("omits thread= when the turn is not in one, rather than printing undefined", () => {
    const header = contextHeader({ channel_id: "R1", user_name: "maria" }, true);
    expect(header).toBe("[DM · from @maria · room=R1]");
    expect(header).not.toContain("thread=");
  });
});

describe("engagement survives a restart", () => {
  it("round-trips a room's engaged threads", () => {
    const snapshot = serializeEngagement(roomsOf({ room1: ["a", "b"] }));
    expect(snapshot).toEqual({ room1: { ids: ["a", "b"] } });
    expect([...deserializeEngagement(snapshot).get("room1")!.engagedIds]).toEqual(["a", "b"]);
  });

  it("preserves eviction order, so a reload doesn't change what's forgotten first", () => {
    const ids = new Set<string>();
    remember(ids, "old");
    remember(ids, "new");
    remember(ids, "old"); // refreshes recency — "new" is now the oldest
    const back = deserializeEngagement(serializeEngagement(new Map([["r", { engagedIds: ids, threadOwners: new Map() }]])));
    expect([...back.get("r")!.engagedIds]).toEqual(["new", "old"]);
  });

  it("drops rooms that remember nothing rather than writing empty arrays", () => {
    expect(serializeEngagement(roomsOf({ empty: [], real: ["x"] }))).toEqual({ real: { ids: ["x"] } });
  });

  it("caps how many rooms one snapshot can hold", () => {
    const many = roomsOf(Object.fromEntries([...Array(10)].map((_, i) => [`r${i}`, ["x"]])));
    expect(Object.keys(serializeEngagement(many, 3))).toHaveLength(3);
  });

  it("re-applies the per-room cap, so a hand-edited file can't grow unbounded", () => {
    const oversized = { room1: [...Array(MAX_TRACKED_IDS + 25)].map((_, i) => `id${i}`) };
    expect(deserializeEngagement(oversized).get("room1")!.engagedIds.size).toBe(MAX_TRACKED_IDS);
  });

  it("keeps the NEWEST ids when re-applying the cap", () => {
    const back = deserializeEngagement({ room1: ["oldest", "middle", "newest"] }, 2);
    expect([...back.get("room1")!.engagedIds]).toEqual(["middle", "newest"]);
  });

  it("survives junk on disk instead of taking the boot down with it", () => {
    // Every one of these has been a real shape at some point: a truncated write,
    // an older format, a hand-edit.
    expect(deserializeEngagement(null).size).toBe(0);
    expect(deserializeEngagement("nonsense").size).toBe(0);
    expect(deserializeEngagement([1, 2, 3]).size).toBe(0);
    expect(deserializeEngagement({ room1: "not-an-array" }).size).toBe(0);
    expect(deserializeEngagement({ room1: [1, null, "keeper"] }).get("room1")!.engagedIds).toEqual(
      new Set(["keeper"]),
    );
  });
});

describe("nudging instead of silent ignoring", () => {
  /** A room where the agent has posted in thread `t1` and nowhere else. */
  const roomEngagedIn = (...ids: string[]): RoomEngagement => ({
    engagedIds: new Set(ids),
    threadOwners: new Map(),
  });

  it("nudges someone replying in a thread we're already in", () => {
    // They had every reason to expect an answer, so silence
    // reads as "the agent is down" rather than "the agent isn't listening".
    expect(worthNudging({ tmid: "t1" }, roomEngagedIn("t1"))).toBe(true);
  });

  it("stays out of a threaded conversation we have no part in", () => {
    // Two humans threading their own exchange. The old test asked only whether
    // the message was aimed at SOMETHING, so this drew an interjection.
    expect(worthNudging({ tmid: "t9" }, roomEngagedIn("t1"))).toBe(false);
  });

  it("stays silent on a file dropped in a channel for other humans", () => {
    // A .docx posted at channel root, aimed at nobody. It has no tmid, so the
    // caller's cooldown key would fall back to the message's own id — unique per
    // message — and every single upload would nudge.
    expect(worthNudging({ message_id: "m1" }, roomEngagedIn("t1"))).toBe(false);
  });

  it("stays silent on ordinary channel chatter, which is the common case", () => {
    // The whole risk of this feature: answering every human message with
    // "I only reply to @mentions" would be far worse than saying nothing.
    expect(worthNudging({ message_id: "m1" }, roomEngagedIn())).toBe(false);
  });

  it("allows the first nudge and blocks the next one in the same thread", () => {
    const last = new Map<string, number>();
    expect(nudgeAllowed(last, "room:thread", 1000, 60_000)).toBe(true);
    expect(nudgeAllowed(last, "room:thread", 5000, 60_000)).toBe(false);
  });

  it("allows again once the cooldown has passed", () => {
    const last = new Map<string, number>();
    nudgeAllowed(last, "k", 0, 60_000);
    expect(nudgeAllowed(last, "k", 60_001, 60_000)).toBe(true);
  });

  it("tracks threads independently, so one noisy thread can't mute another", () => {
    const last = new Map<string, number>();
    expect(nudgeAllowed(last, "a", 0, 60_000)).toBe(true);
    expect(nudgeAllowed(last, "b", 0, 60_000)).toBe(true);
  });

  it("bounds its own bookkeeping rather than growing forever", () => {
    const last = new Map<string, number>();
    for (let i = 0; i < 500; i++) nudgeAllowed(last, `k${i}`, i, 0);
    expect(last.size).toBeLessThanOrEqual(MAX_TRACKED_IDS * 4 + 1);
  });
});

describe("shouldHydrateRoot", () => {
  // The case this exists for: an article URL posted as a thread root with no
  // @mention, then "@bot summarise this" as a reply. Without the root, the agent
  // receives only the second line and answers that it sees no article.
  const base = { isDM: false, respondToAll: false, conversationStarted: false };

  it("hydrates when pulled into a channel thread it has taken no turn in", () => {
    expect(shouldHydrateRoot({ ...base, tmid: "root1" })).toBe(true);
  });

  it("does not hydrate a top-level message — it IS the root, nothing precedes it", () => {
    expect(shouldHydrateRoot({ ...base, tmid: undefined })).toBe(false);
  });

  it("does not re-read the root on follow-ups once the conversation is chained", () => {
    expect(shouldHydrateRoot({ ...base, tmid: "root1", conversationStarted: true })).toBe(false);
  });

  it("hydrates a DM thread too, now that it has its own conversation", () => {
    // A DM thread keys on its own tmid, so it starts EMPTY — the root is a
    // top-level message that keyed on the room and is not in here. Skipping
    // would leave the agent without the subject inside a DM.
    expect(shouldHydrateRoot({ ...base, tmid: "root1", isDM: true })).toBe(true);
  });

  it("skips RESPOND_TO_ALL in a channel, where the root was relayed into this same conversation", () => {
    // A top-level message keys on its own id, which is exactly the tmid its
    // replies carry — so under RESPOND_TO_ALL the root is already in here.
    expect(shouldHydrateRoot({ ...base, tmid: "root1", respondToAll: true })).toBe(false);
  });

  it("still hydrates a DM thread under RESPOND_TO_ALL — the root keyed on the ROOM, not on here", () => {
    expect(shouldHydrateRoot({ ...base, tmid: "root1", isDM: true, respondToAll: true })).toBe(true);
  });

  it("still hydrates a thread the agent only nudged in — a nudge is not a turn", () => {
    // A nudge posts through `reply`, which marks the thread ENGAGED. That thread
    // is precisely one whose root the agent never saw, so engagement must not be
    // what suppresses hydration — only an actual turn is.
    expect(shouldHydrateRoot({ ...base, tmid: "nudged-thread" })).toBe(true);
  });
});

describe("shouldEngage — the gate fails closed", () => {
  // Another bot posting an announcement into a thread the agent has replied in
  // must not get a turn: asking only WHERE a message is lets a loop fill a room.
  const owners = new Map([["T1", "maria"]]);

  it("ignores another bot posting into a thread the agent is in", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "T1", sender: "notes-bot", threadOwners: owners }),
    ).toBe(false);
  });

  it("still answers the human who started the thread, with no mention", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "T1", sender: "maria", threadOwners: owners }),
    ).toBe(true);
  });

  it("matches the owner case-insensitively", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "T1", sender: "Maria", threadOwners: owners }),
    ).toBe(true);
  });

  it("makes a DIFFERENT human mention us — the accepted behaviour change", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "T1", sender: "sam", threadOwners: owners }),
    ).toBe(false);
    expect(
      shouldEngage({ mentioned: true, isDM: false, tmid: "T1", sender: "sam", threadOwners: owners }),
    ).toBe(true);
  });

  it("fails closed on a thread with no recorded owner", () => {
    // The state after a deploy from before this change: ids restored, owners
    // empty. One mention re-establishes ownership; silence is the safe default.
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "UNKNOWN", sender: "maria", threadOwners: owners }),
    ).toBe(false);
  });

  it("fails closed when RC gives us no sender", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, tmid: "T1", sender: undefined, threadOwners: owners }),
    ).toBe(false);
  });

  it("always engages on a mention or a DM", () => {
    expect(shouldEngage({ mentioned: true, isDM: false, threadOwners: new Map() })).toBe(true);
    expect(shouldEngage({ mentioned: false, isDM: true, threadOwners: new Map() })).toBe(true);
  });

  it("ignores a top-level channel message from anyone", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, sender: "maria", threadOwners: owners }),
    ).toBe(false);
  });

  it("engages someone we NAMED in the thread root, who therefore owns nothing", () => {
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "ANNOUNCE",
        sender: "maria",
        threadOwners: owners,
        invited: true,
      }),
    ).toBe(true);
  });

  it("still ignores an uninvited sender in an announcement thread", () => {
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "ANNOUNCE",
        sender: "notes-bot",
        threadOwners: owners,
        invited: false,
      }),
    ).toBe(false);
  });
});

describe("rootInvites — did WE open this thread by naming you?", () => {
  const us = { userId: "helperId", username: "helper" };
  const announcement = {
    u: { _id: "helperId", username: "helper" },
    mentions: [{ _id: "mariaId", username: "maria" }],
    msg: "@maria Human attention needed on the invoice run.",
  };

  it("invites the person the announcement named", () => {
    expect(rootInvites(announcement, us, "maria")).toBe(true);
  });

  it("is case-insensitive on the sender", () => {
    expect(rootInvites(announcement, us, "Maria")).toBe(true);
  });

  it("does not invite someone the announcement did not name", () => {
    expect(rootInvites(announcement, us, "sam")).toBe(false);
  });

  it("does not invite anyone when the root is someone else's message", () => {
    const humanRoot = { ...announcement, u: { _id: "samId", username: "sam" } };
    expect(rootInvites(humanRoot, us, "maria")).toBe(false);
  });

  it("recognizes our own root by username when RC omits the id", () => {
    expect(rootInvites({ ...announcement, u: { username: "Helper" } }, us, "maria")).toBe(true);
  });

  it("treats @all in OUR root as inviting every human in the room", () => {
    // The standup case: the agent roots "@all — one line each" and the SECOND
    // human to answer must be seated too, even though the first has already
    // claimed the thread's owner seat.
    const toEveryone = {
      u: { _id: "helperId" },
      mentions: [{ username: "all" }],
      msg: "@all — one line each: what you're on today",
    };
    expect(rootInvites(toEveryone, us, "maria")).toBe(true);
    expect(rootInvites(toEveryone, us, "sam")).toBe(true);
    expect(rootInvites(toEveryone, us, "all")).toBe(false);
  });

  it("invites everyone via the text fallback when RC parsed no mentions", () => {
    const unparsed = { u: { _id: "helperId" }, msg: "@all standup in 5" };
    expect(rootInvites(unparsed, us, "sam")).toBe(true);
    // A room tag has to be a word, not a prefix — "@allison" addresses a person.
    expect(rootInvites({ u: { _id: "helperId" }, msg: "@allison take a look" }, us, "sam")).toBe(false);
  });

  it("does not turn @all in someone ELSE's root into an invitation", () => {
    const humanBroadcast = {
      u: { _id: "samId", username: "sam" },
      mentions: [{ username: "all" }],
      msg: "@all standup in 5",
    };
    expect(rootInvites(humanBroadcast, us, "maria")).toBe(false);
  });

  it("still invites the named person when our root tags both them and the room", () => {
    const both = {
      u: { _id: "helperId" },
      mentions: [{ username: "all" }, { username: "maria" }],
      msg: "@all standup; @maria decide the watch scope",
    };
    expect(rootInvites(both, us, "maria")).toBe(true);
    expect(rootInvites(both, us, "sam")).toBe(true);
  });

  it("falls back to the text when RC parsed no mentions", () => {
    const unparsed = { u: { _id: "helperId" }, msg: "@maria please decide the watch scope" };
    expect(rootInvites(unparsed, us, "maria")).toBe(true);
    expect(rootInvites(unparsed, us, "juli")).toBe(false);
  });

  it("does not invite on a bare prefix match in the text", () => {
    const unparsed = { u: { _id: "helperId" }, msg: "@mariargh" };
    expect(rootInvites(unparsed, us, "maria")).toBe(false);
  });

  it("is false for an unreadable root or a missing sender", () => {
    expect(rootInvites(undefined, us, "maria")).toBe(false);
    expect(rootInvites(announcement, us, undefined)).toBe(false);
  });
});

describe("rootIsOurs — did WE post the message this thread hangs off?", () => {
  const us = { userId: "helperId", username: "helper" };

  it("recognizes our own root by id, and by username when RC omits the id", () => {
    expect(rootIsOurs({ u: { _id: "helperId" } }, us)).toBe(true);
    expect(rootIsOurs({ u: { username: "Helper" } }, us)).toBe(true);
  });

  it("does not claim a human's root", () => {
    expect(rootIsOurs({ u: { _id: "mariaId", username: "maria" } }, us)).toBe(false);
  });

  it("is false for an unreadable root, so RC being unavailable never opens the gate", () => {
    expect(rootIsOurs(undefined, us)).toBe(false);
    expect(rootIsOurs({}, us)).toBe(false);
  });

  // One brain, several faces: @concierge and @help.desk ARE us. Compared against
  // `us.username` alone, a thread rooted on another face's scheduled post would
  // never be "ours", and every reply in it that did not retype an @mention would
  // be dropped without a word.
  const withFaces = { ...us, faces: ["concierge", "help.desk"] };

  it("claims a root posted by one of our other faces", () => {
    expect(rootIsOurs({ u: { _id: "conciergeId", username: "concierge" } }, withFaces)).toBe(true);
    expect(rootIsOurs({ u: { username: "help.desk" } }, withFaces)).toBe(true);
  });

  it("matches a face case-insensitively, as RC may report it either way", () => {
    expect(rootIsOurs({ u: { username: "Concierge" } }, withFaces)).toBe(true);
  });

  it("still refuses a human's root when faces are configured", () => {
    expect(rootIsOurs({ u: { _id: "mariaId", username: "maria" } }, withFaces)).toBe(false);
  });

  it("does not claim another face's root when that face is not ours", () => {
    expect(rootIsOurs({ u: { username: "concierge" } }, us)).toBe(false);
  });
});

describe("shouldEngage — answering an announcement we rooted", () => {
  // A scheduled job announces "Human attention needed on the invoice run" —
  // naming nobody, because it does not know who will pick it up. A reply from
  // whoever does must not be dropped as "not named in or owner of thread".
  const unclaimed = new Map<string, string>();

  it("engages the first human to answer, even though the announcement named nobody", () => {
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "ANNOUNCE",
        sender: "maria",
        threadOwners: unclaimed,
        invited: false,
        ourRoot: true,
      }),
    ).toBe(true);
  });

  it("hands out ONE seat: once the thread is owned, everyone else is back to @mentioning", () => {
    const owned = new Map([["ANNOUNCE", "maria"]]);
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "ANNOUNCE",
        sender: "sam",
        threadOwners: owned,
        ourRoot: true,
      }),
    ).toBe(false);
    // …and the owner still continues their own conversation freely.
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "ANNOUNCE",
        sender: "maria",
        threadOwners: owned,
        ourRoot: true,
      }),
    ).toBe(true);
  });

  it("does not engage on a root somebody else posted — the loop case stays shut", () => {
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "T2",
        sender: "notes-bot",
        threadOwners: unclaimed,
        ourRoot: false,
      }),
    ).toBe(false);
  });

  it("still needs a thread: a top-level message in a channel is not an answer to anything", () => {
    expect(
      shouldEngage({ mentioned: false, isDM: false, sender: "maria", threadOwners: unclaimed, ourRoot: true }),
    ).toBe(false);
  });
});

describe("rememberOwner", () => {
  it("records the first human to engage a thread", () => {
    const owners = new Map<string, string>();
    rememberOwner(owners, "T1", "Maria");
    expect(owners.get("T1")).toBe("maria");
  });

  it("does NOT let a later participant take over the thread", () => {
    const owners = new Map<string, string>();
    rememberOwner(owners, "T1", "maria");
    rememberOwner(owners, "T1", "sam");
    expect(owners.get("T1")).toBe("maria");
  });

  it("ignores missing thread or sender", () => {
    const owners = new Map<string, string>();
    rememberOwner(owners, undefined, "maria");
    rememberOwner(owners, "T1", undefined);
    expect(owners.size).toBe(0);
  });

  it("bounds itself like the id set does", () => {
    const owners = new Map<string, string>();
    for (let i = 0; i < 10; i++) rememberOwner(owners, `t${i}`, "maria", 3);
    expect(owners.size).toBe(3);
  });
});

describe("thread owners survive a restart", () => {
  it("round-trips owners alongside ids", () => {
    const snapshot = serializeEngagement(roomsOf({ r1: ["T1"] }, { r1: { T1: "maria" } }));
    expect(snapshot).toEqual({ r1: { ids: ["T1"], owners: { T1: "maria" } } });
    expect(deserializeEngagement(snapshot).get("r1")!.threadOwners.get("T1")).toBe("maria");
  });

  it("still reads the OLD bare-array file, so a deploy drops nothing", () => {
    // What is on disk right now, written before this change.
    const back = deserializeEngagement({ room1: ["a", "b"] });
    expect([...back.get("room1")!.engagedIds]).toEqual(["a", "b"]);
    expect(back.get("room1")!.threadOwners.size).toBe(0);
  });

  it("drops an owner whose thread is no longer remembered", () => {
    const back = deserializeEngagement({ r1: { ids: ["T1"], owners: { T1: "maria", GONE: "sam" } } });
    expect(back.get("r1")!.threadOwners.has("GONE")).toBe(false);
  });

  it("survives junk in the owners map", () => {
    const back = deserializeEngagement({ r1: { ids: ["T1"], owners: "nope" } as never });
    expect(back.get("r1")!.engagedIds.has("T1")).toBe(true);
    expect(back.get("r1")!.threadOwners.size).toBe(0);
  });
});

describe("the loop backstop lives in the client's post cap", () => {
  // There is exactly ONE ceiling, and it counts what the bridge EMITS (the
  // client's `withinRate`, tested there). A turn cap could only ever fire on a
  // person. If a `DEFAULT_MAX_TURNS_PER_THREAD` ever reappears, this is where the
  // argument for it has to be made again.
  it("bounds what the bridge emits, and nothing about how long a human may talk", () => {
    expect(DEFAULT_LOOP_WINDOW_MS).toBe(10 * 60_000);
    expect(DEFAULT_MAX_POSTS_PER_THREAD).toBe(40);
    expect(Object.keys(threading)).not.toContain("DEFAULT_MAX_TURNS_PER_THREAD");
  });
});

describe("rootAddressesUs — did a human open this thread by tagging us?", () => {
  const us = { userId: "helperId", username: "helper", faces: ["concierge", "help.desk"] };

  // A human opens a thread by tagging us; the agent asks the room a question.
  const samsRequest = {
    u: { _id: "samId", username: "sam" },
    mentions: [{ _id: "helperId", username: "helper" }],
    msg: "@Helper We need to log a work item for Example to lubricate the blender at 12 Harbor Lane (unit B)",
  };

  it("recognises a root that tagged us, even though we did not write it", () => {
    expect(rootAddressesUs(samsRequest, us)).toBe(true);
    // …and the older rules still say no, which is exactly why this one exists.
    expect(rootIsOurs(samsRequest, us)).toBe(false);
    expect(rootInvites(samsRequest, us, "maria")).toBe(false);
  });

  it("matches on the id when RC reports the mention without a username", () => {
    expect(rootAddressesUs({ ...samsRequest, mentions: [{ _id: "helperId" }] }, us)).toBe(true);
  });

  it("recognises any of our faces, not just the agent's own account", () => {
    const toConcierge = {
      u: { _id: "samId", username: "sam" },
      mentions: [{ _id: "conciergeId", username: "concierge" }],
      msg: "@concierge the blender is dead again",
    };
    expect(rootAddressesUs(toConcierge, us)).toBe(true);
  });

  it("does not treat a root that tags somebody else as ours", () => {
    const toSam = {
      u: { _id: "mariaId", username: "maria" },
      mentions: [{ _id: "samId", username: "sam" }],
      msg: "@sam can you look at this",
    };
    expect(rootAddressesUs(toSam, us)).toBe(false);
  });

  it("never counts @all / @here / @channel — a room broadcast is not addressed to us", () => {
    const broadcast = {
      u: { _id: "samId", username: "sam" },
      mentions: [{ username: "all" }],
      msg: "@all standup in five",
    };
    expect(rootAddressesUs(broadcast, us)).toBe(false);
  });

  it("falls back to the text when RC reports no parsed mentions", () => {
    const unparsed = { u: { _id: "samId", username: "sam" }, msg: "@helper log this please" };
    expect(rootAddressesUs(unparsed, us)).toBe(true);
    // …word-bounded, so a near-miss is not us.
    expect(rootAddressesUs({ ...unparsed, msg: "@helperbot log this" }, us)).toBe(false);
  });

  it("escapes the face before matching, so @helpxdesk is not @help.desk", () => {
    const nearMiss = { u: { _id: "samId", username: "sam" }, msg: "@helpxdesk are you there" };
    expect(rootAddressesUs(nearMiss, us)).toBe(false);
    expect(rootAddressesUs({ ...nearMiss, msg: "@help.desk are you there" }, us)).toBe(true);
  });

  it("says no to a missing root rather than throwing", () => {
    expect(rootAddressesUs(undefined, us)).toBe(false);
  });
});

describe("shouldEngage — a teammate answers a question we were asked", () => {
  // sam opened the thread, so sam owns it. The agent then asked the ROOM which
  // known property "12 Harbor Lane" is, and Maria answered.
  const ownedBySam = new Map([["THREAD_ASKED", "sam"]]);
  const mariaAnswering = {
    mentioned: false,
    isDM: false,
    tmid: "THREAD_ASKED",
    sender: "maria",
    threadOwners: ownedBySam,
    invited: false,
    ourRoot: false,
  };

  it("REGRESSION: refused her answer before the root-tag rule", () => {
    expect(shouldEngage(mariaAnswering)).toBe(false);
  });

  it("engages her once the root is known to have tagged us", () => {
    expect(shouldEngage({ ...mariaAnswering, rootAddressesUs: true })).toBe(true);
  });

  it("does not hand out a single seat — a third teammate may answer too", () => {
    expect(
      shouldEngage({ ...mariaAnswering, sender: "someone-else", rootAddressesUs: true }),
    ).toBe(true);
  });

  it("leaves a thread whose root never tagged us exactly as closed as before", () => {
    expect(shouldEngage({ ...mariaAnswering, rootAddressesUs: false })).toBe(false);
  });

  it("the loop case still holds: a thread whose root tagged nobody stays shut", () => {
    // Another bot posting into a thread it did not root.
    expect(
      shouldEngage({
        mentioned: false,
        isDM: false,
        tmid: "T1",
        sender: "notes-bot",
        threadOwners: new Map([["T1", "maria"]]),
        rootAddressesUs: false,
      }),
    ).toBe(false);
  });
});

describe("our faces — one brain, several names", () => {
  const us = { userId: "helperId", username: "helper", faces: ["concierge", "help.desk"] };

  it("answers to every name on the roster", () => {
    expect(botFaces(us)).toEqual(["helper", "concierge", "help.desk"]);
    expect(mentionsUs("@helper log this", us)).toBe(true);
    expect(mentionsUs("@concierge the blender is dead", us)).toBe(true);
    expect(mentionsUs("@help.desk my back hurts", us)).toBe(true);
  });

  it("REGRESSION: tagging another face in a channel must reach us", () => {
    const helperOnly = { userId: "helperId", username: "helper" };
    expect(mentionsUs("@concierge the blender is dead", helperOnly)).toBe(false);
  });

  it("is not fooled by a name that merely starts the same", () => {
    expect(mentionsUs("@conciergerie is on Tuesday", us)).toBe(false);
    expect(mentionsUs("ask @helpxdesk about it", us)).toBe(false);
  });

  it("dedupes, so a roster that repeats our own name does not double-match", () => {
    expect(botFaces({ userId: "x", username: "helper", faces: ["helper", "concierge"] })).toEqual([
      "helper",
      "concierge",
    ]);
  });

  it("strips whichever face was used, so the model gets the request not the addressing", () => {
    expect(stripOurMentions("@concierge the blender is dead", us)).toBe("the blender is dead");
    expect(stripOurMentions("@help.desk my back hurts", us)).toBe("my back hurts");
    expect(stripOurMentions("@helper  log this", us)).toBe("log this");
  });

  it("leaves someone else's mention alone", () => {
    expect(stripOurMentions("@sam and @helper look at this", us)).toBe("@sam and  look at this");
  });
});
