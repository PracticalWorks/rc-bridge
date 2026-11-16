/**
 * Normalize a post target, preserving the sigil that decides WHERE it lands:
 * `#name` is a channel, `@name` is a direct message. A bare name is a channel,
 * since that is the common case and the safer default (a channel post is visible
 * and correctable; a DM to the wrong person is not).
 *
 * Case-folded so "#General" and "general" are one target, and so an allowlist
 * entry cannot be bypassed by capitalization.
 */
export function normalizeChannel(target: string): string {
  const trimmed = target.trim().toLowerCase();
  if (trimmed.startsWith("@")) return trimmed;
  return trimmed.replace(/^#/, "");
}

/** Is this target a direct message rather than a channel post? */
export function isDirectTarget(target: string): boolean {
  return normalizeChannel(target).startsWith("@");
}

/**
 * Normalize a list of post targets into the set an allowlist check compares
 * against. Entries may be channels (`general`, `#general`) or DMs (`@sam`).
 *
 * An empty list yields an EMPTY set, which callers must treat as "posting is
 * off" rather than "everything is allowed": the caller is often an unattended
 * scheduled job, and the failure that matters is a stray post landing in front
 * of the wrong audience.
 */
export function normalizeTargets(targets: readonly string[]): Set<string> {
  return new Set(targets.map(normalizeChannel).filter(Boolean));
}
