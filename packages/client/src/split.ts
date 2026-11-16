/**
 * Splitting a message Rocket.Chat would refuse.
 *
 * Rocket.Chat enforces `Message_MaxAllowedSize` (5000 characters by default) and
 * answers a longer `chat.postMessage` or `chat.sendMessage` with 400
 * `error-message-size-exceeded`. Nothing of the message is posted. So a long text
 * goes out as several messages instead of vanishing.
 */

/** Ceiling per message, under Rocket.Chat's default 5000 so a part plus its
 * continuation marker and a closing fence still fits. */
export const RC_MAX_MESSAGE_CHARS = 4000;

/** How many parts one text may become. A runaway text turns into a readable
 * prefix plus a truncation notice, never fifty messages. */
export const RC_MAX_PARTS = 5;

const CONTINUES = "…";
const TRUNCATED = "\n\n_[truncated — the rest was too long to post]_";

/** Is this line a ``` fence? */
const isFence = (line: string) => /^\s*```/.test(line);

/** Hard-split a single oversized line (a pasted blob with no newlines). */
function splitLongLine(line: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
  return out;
}

/**
 * Split `text` into messages Rocket.Chat will accept.
 *
 * Splits on line boundaries so prose and code stay readable, and tracks ``` fences
 * across a boundary: a part that ends inside a fence closes it, and the next part
 * reopens it. Without that, splitting a log dump renders the rest of the room as
 * one giant code block.
 *
 * Returns `[text]` untouched when it already fits, which is nearly every message.
 */
export function splitForRc(text: string, max = RC_MAX_MESSAGE_CHARS, maxParts = RC_MAX_PARTS): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let current = "";
  let fenceOpen = false;
  let currentStartedFenced = false;

  const flush = () => {
    if (!current) return;
    // Close a fence this part leaves open, so it renders on its own.
    parts.push(fenceOpen ? `${current}\n\`\`\`` : current);
    current = "";
    currentStartedFenced = fenceOpen;
  };

  const budget = () => max - CONTINUES.length - (currentStartedFenced ? 8 : 0);

  for (const rawLine of text.split("\n")) {
    for (const line of rawLine.length > budget() ? splitLongLine(rawLine, budget()) : [rawLine]) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > budget() && current) {
        flush();
        current = currentStartedFenced ? `\`\`\`\n${line}` : line;
      } else {
        current = candidate;
      }
      if (isFence(line)) fenceOpen = !fenceOpen;
    }
  }
  flush();

  if (parts.length <= maxParts) return parts;
  // The notice must fit inside the ceiling too, so the last kept part gives up
  // room for it, keeping a closing fence it carries.
  const kept = parts.slice(0, maxParts);
  const last = kept[kept.length - 1] ?? "";
  const fence = last.endsWith("\n```") ? "\n```" : "";
  const room = max - TRUNCATED.length - fence.length;
  const body = fence ? last.slice(0, -fence.length) : last;
  kept[kept.length - 1] = `${body.slice(0, room)}${fence}${TRUNCATED}`;
  return kept;
}
