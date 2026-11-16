
// A message that arrives mid-turn is a message, not noise.
//
// The busy guard is right that a second message cannot join a turn
// already in flight: the gateway is mid-run, and two answers interleaving in one
// thread is the confusion it was written to prevent. But it must not DROP that
// message: a person told "⏳ Still on your last message" reads it as queued, and
// a dropped message never reaches the agent at all.
//
// That window is not small: turns of a minute or two are ordinary, and
// `AGENT_TIMEOUT_MS` allows six. So hold the message instead, and say so. Kept
// apart from main.ts, which reads required env at import time, so this is
// unit-testable.

/** A message held while its conversation was busy. */
export interface HeldFollowUp<T> {
  payload: T;
  /** When it was held, for the TTL below. */
  at: number;
}

/** How long a held message stays worth running.
 *
 * A hold exists to survive ONE turn, and a turn is bounded by
 * `AGENT_TIMEOUT_MS` (six minutes). Past that the turn it was waiting behind
 * did not merely run long, something went wrong — the gateway hung, the process
 * restarted mid-flight — and replaying a stale message into a conversation that
 * has since moved on is worse than dropping it, because it arrives with no
 * indication that it is ten minutes late. */
export const FOLLOWUP_TTL_MS = 10 * 60_000;

/** How many conversations may hold a message at once. A backstop: holds are one
 * per conversation and are consumed by the turn they queue behind, so this only
 * matters if turns stop finishing. */
const MAX_HELD_FOLLOWUPS = 200;

/**
 * Hold this message until the conversation's current turn ends.
 *
 * ONE per conversation, and the LATEST wins. A person who types three lines
 * while waiting is not asking for three turns — the later lines are usually a
 * correction or a completion of the first, and replaying a backlog into a
 * conversation that has already been answered is its own kind of wrong.
 *
 * Returns whether this REPLACED an earlier hold, so the caller can log the
 * message it is choosing not to run. Discarding silently is the failure this
 * module exists to prevent; discarding on purpose and saying so in the log is not.
 */
export function holdFollowUp<T>(
  held: Map<string, HeldFollowUp<T>>,
  conversation: string,
  payload: T,
  now: number,
  max = MAX_HELD_FOLLOWUPS,
): { replaced: boolean } {
  const replaced = held.has(conversation);
  held.set(conversation, { payload, at: now });
  // Bounded like every other map in the bridge. Oldest key first, and never the
  // one just written — evicting the hold we were asked to keep would be the
  // original bug with extra steps.
  while (held.size > max) {
    const oldest = held.keys().next().value;
    if (oldest === undefined || oldest === conversation) break;
    held.delete(oldest);
  }
  return { replaced };
}

/**
 * Take the message held for this conversation, if it is still worth running.
 *
 * Always removes it, expired or not: a hold that is too old to run is also too
 * old to keep, and leaving it would let one abandoned conversation pin a payload
 * in memory forever.
 */
export function takeFollowUp<T>(
  held: Map<string, HeldFollowUp<T>>,
  conversation: string,
  now: number,
  ttlMs = FOLLOWUP_TTL_MS,
): T | undefined {
  const pending = held.get(conversation);
  if (!pending) return undefined;
  held.delete(conversation);
  return now - pending.at > ttlMs ? undefined : pending.payload;
}
