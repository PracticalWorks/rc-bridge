// The "the agent is down" reply: said once per room per outage, per profile.
//
// One deployment can route rooms to several agent profiles (a plugin's
// `targetForRoom`). An outage belongs to the profile that failed, so:
//
//   - a success on one profile must not end another profile's outage, or the
//     failing profile repeats its warning after every success elsewhere;
//   - a room that has not been told must still hear it, even while another room
//     on the same profile was told first.
//
// What the room is told names the KIND of failure, from the error's type and
// status, never from the server's text: a gateway's error body can carry
// anything, so it goes to the log and not into a channel.

import { AgentHttpError, AgentRunFailedError } from "./agent.js";

/** The profile a turn is filed under when no plugin routed it. */
export const DEFAULT_PROFILE = "default";

/** Rooms remembered per outage before the oldest is forgotten (it may be told again). */
const MAX_TOLD_ROOMS = 500;

/** One sentence naming what went wrong, safe to post: no server text in it. */
export function describeAgentFailure(err: unknown): string {
  if (err instanceof AgentHttpError) {
    if (err.status === 429) return `The agent is rate limited right now (HTTP 429)`;
    if (err.status === 401 || err.status === 403) return `The agent refused the bridge's key (HTTP ${err.status})`;
    return `The agent answered with an error (HTTP ${err.status})`;
  }
  if (err instanceof AgentRunFailedError) return `The agent started this turn, but the run failed`;
  return `Can't reach the agent right now`;
}

/** The reply a room gets the first time an outage reaches it. */
export function outageReply(err: unknown): string {
  return `⚠️ ${describeAgentFailure(err)}. I'll stay quiet in this room until it's back.`;
}

/** Which rooms each failing profile has already told. */
export function createAgentOutages() {
  const told = new Map<string, Set<string>>();

  return {
    /** Record a failure. True when this room has not heard about this outage yet. */
    failed(profile: string, roomId: string): boolean {
      let rooms = told.get(profile);
      if (!rooms) {
        rooms = new Set();
        told.set(profile, rooms);
      }
      if (rooms.has(roomId)) return false;
      rooms.add(roomId);
      if (rooms.size > MAX_TOLD_ROOMS) {
        const oldest = rooms.values().next().value;
        if (oldest !== undefined) rooms.delete(oldest);
      }
      return true;
    },
    /** A turn on this profile succeeded: its outage is over, in every room. */
    recovered(profile: string): void {
      told.delete(profile);
    },
    /** Rooms already told, for one profile. */
    toldCount(profile: string): number {
      return told.get(profile)?.size ?? 0;
    },
  };
}
