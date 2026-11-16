/**
 * The post cap: a sliding-window counter per key (a room and thread), so a loop
 * between two bots cannot flood a room. It counts what the client sends, and
 * nothing about how much a person may say.
 */

/** Window and ceiling a caller can start from: 40 posts per thread per 10 minutes. */
export const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000;
export const DEFAULT_MAX_POSTS_PER_THREAD = 40;

/** How many keys the counter keeps before it drops the oldest. */
export const MAX_RATE_KEYS = 200;

/** Returns false once `max` events have happened inside `windowMs`, and prunes as
 * it goes so the map cannot grow forever. */
export function withinRate(
  seen: Map<string, number[]>,
  key: string,
  now: number,
  max: number,
  windowMs: number,
): boolean {
  const cutoff = now - windowMs;
  const hits = (seen.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) {
    seen.set(key, hits);
    return false;
  }
  hits.push(now);
  seen.set(key, hits);
  // A busy workspace must not accumulate a key per thread forever.
  if (seen.size > MAX_RATE_KEYS) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined && oldest !== key) seen.delete(oldest);
  }
  return true;
}
