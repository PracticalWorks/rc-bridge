
// Bounding a room's agent conversation.
//
// `conversationKey` maps every top-level message in a DM (or an unthreaded
// channel message) to ONE named agent conversation, and a Responses API that
// chains named conversations chains them forever: a gateway's session reset may
// default to never, and a named conversation never sees `/new` because the
// bridge forwards it as prose. So a room's context only ever grows.
//
// Unbounded, it breaks quietly: each turn spends its time compressing the
// history, and the model answers from the compressed summary, claiming its
// tools are unreachable without calling one, while every tool is up.
//
// Two bounds, both applied only to the ROOM-level key. A thread key already
// starts fresh and is left alone:
//
//   1. A daily boundary at a fixed local hour, 04:00, so the boundary falls where nobody is
//      mid-conversation. Continuity WITHIN a day is unchanged.
//   2. A human typing `/new` or `/reset` bumps the room's epoch by hand, for
//      the day the context has gone bad before the boundary. Persisted, so a
//      bridge restart cannot quietly hand a "reset" room its old context back.
//
// Nothing here talks to Rocket.Chat or the agent, so it is testable without
// booting the bridge.

import { readFileSync, writeFileSync } from "node:fs";

/** The daily boundary: 4 AM local. */
const DAILY_RESET_HOUR = 4;

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The calendar day a moment belongs to, where days roll over at `atHour`
 * local time rather than midnight. 03:59 on the 2nd is still the 1st's day.
 *
 * Decided from the LOCAL clock, not by subtracting `atHour` hours from the
 * instant: those differ whenever the UTC offset moves. On the morning the
 * clocks fall back, 03:30 EST is four hours and thirty minutes after the
 * previous 04:00 boundary by the instant arithmetic, yet still before 04:00
 * by the clock on the wall — and the wall clock is the one the boundary was
 * promised in.
 */
export function dailyEpoch(now: Date, atHour: number = DAILY_RESET_HOUR): string {
  // `new Date(y, m, d - 1)` normalises across month and year ends.
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < atHour ? 1 : 0));
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * Is this message a request to start over? `/new` or `/reset`, on its own,
 * case-insensitive, with any @mentions of us already stripped or still
 * present — "@bot /new" and "/new" both count. Anything else ("/new plan
 * for the week") is prose and goes to the agent as usual.
 */
export function isResetCommand(text: string): boolean {
  return /^\s*(?:@[\w.-]+\s+)*\/(?:new|reset)(?:\s+@[\w.-]+)*\s*$/i.test(text);
}

/** What the bridge says back. One line, in the thread the human is in. */
export const RESET_ACK =
  "🧹 Fresh conversation started for this room — earlier messages here are no longer in my context. Threads always start fresh on their own.";

interface RoomEpoch {
  /** The `dailyEpoch` the manual counter belongs to. */
  day: string;
  /** How many times `/new` has been sent since that day began. */
  n: number;
}

/**
 * Per-room manual resets, persisted as `{ [roomId]: { day, n } }`.
 *
 * The counter is scoped to a day so the epoch string stays short and a
 * long-lived room never accumulates a number that means nothing: a `/new`
 * yesterday is already covered by today's boundary.
 */
export class ConversationEpochs {
  private readonly rooms = new Map<string, RoomEpoch>();

  constructor(
    private readonly file: string | undefined,
    private readonly log: (line: string) => void = () => {},
    private readonly atHour: number = DAILY_RESET_HOUR,
  ) {
    this.load();
  }

  /** The epoch to key this room's top-level conversation on, right now. */
  epochFor(roomId: string, now: Date = new Date()): string {
    const day = dailyEpoch(now, this.atHour);
    const manual = this.rooms.get(roomId);
    return manual && manual.day === day && manual.n > 0 ? `${day}.${manual.n}` : day;
  }

  /** A human asked for a fresh start: advance the room's epoch and persist. */
  bump(roomId: string, now: Date = new Date()): string {
    const day = dailyEpoch(now, this.atHour);
    const current = this.rooms.get(roomId);
    const n = current && current.day === day ? current.n + 1 : 1;
    this.rooms.set(roomId, { day, n });
    this.persist();
    return this.epochFor(roomId, now);
  }

  private load(): void {
    if (!this.file) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // no state yet — every room is on its daily epoch
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [roomId, value] of Object.entries(parsed)) {
        const v = value as Partial<RoomEpoch>;
        if (typeof v?.day === "string" && typeof v?.n === "number" && v.n > 0) {
          this.rooms.set(roomId, { day: v.day, n: v.n });
        }
      }
    } catch (err) {
      this.log(`ignoring unreadable conversation epochs in ${this.file}: ${(err as Error)?.message ?? err}`);
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.rooms)), "utf8");
    } catch (err) {
      this.log(`could not persist conversation epochs to ${this.file}: ${(err as Error)?.message ?? err}`);
    }
  }
}
