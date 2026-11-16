
// Reactions: the bridge's receipt on a message it picked up, and
// the agent's way of answering with an emoji instead of a sentence.
//
// Both exist because of how Rocket.Chat NOTIFIES. It notifies when a message is
// CREATED, never when one is edited. A reply created early (a "Thinking…"
// holding line, or the first streamed fragment) and grown with chat.update
// notifies with the placeholder, and the real answer arrives in silence.
//
// So the reply is posted ONCE, when it is finished, and "I heard you" moves
// to a reaction, which notifies nobody: 👀 the moment a message is picked up, ✅
// when the answer lands, ⚠️ when the turn fails.
//
// Kept apart from main.ts so it can be tested without booting the bridge.

/** `chat.react` wants a shortcode NAME that exists on the server — a raw Unicode
 * character is refused ("the emoji must exist"). So the emoji the agent may react
 * with are an explicit map, not a guess at RC's emoji index: an unknown one is
 * reported and skipped rather than 400ing in the dark. */
const SHORTCODES: Record<string, string> = {
  "👀": "eyes",
  "✅": "white_check_mark",
  "⚠️": "warning",
  "⚠": "warning",
  "⏳": "hourglass_flowing_sand",
  "👍": "thumbsup",
  "👎": "thumbsdown",
  "🎉": "tada",
  "❤️": "heart",
  "❤": "heart",
  "😂": "joy",
  "😄": "smile",
  "🙂": "slight_smile",
  "😊": "blush",
  "🙏": "pray",
  "🔥": "fire",
  "👏": "clap",
  "💯": "100",
  "🤔": "thinking",
  "😢": "cry",
  "🙌": "raised_hands",
  "👌": "ok_hand",
  "✨": "sparkles",
  "🚀": "rocket",
  "💪": "muscle",
  "😅": "sweat_smile",
  "🤝": "handshake",
  "📌": "pushpin",
  "📅": "date",
  "🏠": "house",
};

const KNOWN_NAMES = new Set(Object.values(SHORTCODES));

/** The shortcode name for an emoji the agent wrote, or `undefined` when we do not
 * know it. Accepts the character itself, `:name:`, or a bare `name` — whichever
 * form the model reaches for — but only names on the map, for the same reason
 * the map exists. */
export function shortcodeFor(raw: string): string | undefined {
  const trimmed = raw.trim();
  const mapped = SHORTCODES[trimmed] ?? SHORTCODES[trimmed.replace(/️/g, "")];
  if (mapped) return mapped;
  const name = trimmed.replace(/^:|:$/g, "");
  return KNOWN_NAMES.has(name) ? name : undefined;
}

// `[react: 👍]`, `[react: 👍 🎉]`, `[react: :tada:]`. Case-insensitive, and
// anywhere in the reply, because a model does not reliably put a marker first.
const REACT_MARKER = /\[react:\s*([^\]]*)\]/gi;

export interface ReplyReactions {
  /** The reply with every marker removed — what the room should read. */
  text: string;
  /** Shortcode names to react with, deduplicated, in the order written. */
  emoji: string[];
  /** What was inside a marker but is not on the map — logged, never sent. */
  unknown: string[];
}

/** Split the agent's reply into what it SAID and what it REACTED with. */
export function extractReactions(reply: string): ReplyReactions {
  const emoji: string[] = [];
  const unknown: string[] = [];
  const text = reply
    .replace(REACT_MARKER, (_m, inner: string) => {
      for (const token of splitEmoji(inner)) {
        const name = shortcodeFor(token);
        if (name) {
          if (!emoji.includes(name)) emoji.push(name);
        } else {
          unknown.push(token);
        }
      }
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text, emoji, unknown };
}

/** Tokens inside a marker. Separated by spaces or commas when the model does
 * that; otherwise by grapheme, so `[react: 👍🎉]` is two reactions, not one
 * unknown string. */
function splitEmoji(inner: string): string[] {
  const parts = inner.split(/[\s,]+/).filter(Boolean);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return parts.flatMap((part) =>
    part.startsWith(":") || /^[a-z0-9_+-]+$/i.test(part)
      ? [part]
      : [...segmenter.segment(part)].map((s) => s.segment),
  );
}

/** The receipt a turn leaves on the message that started it. */
export const RECEIPT = {
  seen: "eyes",
  done: "white_check_mark",
  failed: "warning",
  /** A turn that ran past the bridge's wait: the agent is still working server-side,
   * so it has neither finished nor failed. */
  waiting: "hourglass_flowing_sand",
} as const;

export type ReceiptState = keyof typeof RECEIPT;

/** The calls that move a message's receipt from one state to the next: take the
 * old reaction off, put the new one on. `to` undefined only takes the old one
 * off — a turn that ended without answering, or one the agent answered with its
 * own reaction, where a ✅ beside it would be noise. `chat.react` with
 * `shouldReact` is a setter, so replaying either half is harmless. */
export function receiptTransition(
  from: ReceiptState | undefined,
  to: ReceiptState | undefined,
): Array<{ emoji: string; shouldReact: boolean }> {
  if (from === to) return [];
  return [
    ...(from ? [{ emoji: RECEIPT[from], shouldReact: false }] : []),
    ...(to ? [{ emoji: RECEIPT[to], shouldReact: true }] : []),
  ];
}

/** How the agent learns it can react, sent with every turn.
 *
 * In the framing, not an agent-side skill: a skill an agent loads only when a
 * request matches it is never loaded for "a reply that is just an
 * acknowledgement", because that matches no request.
 * The framing reaches every profile the bridge fronts, on every turn, whatever
 * model is behind it. One line, because it rides on every turn. */
export const REACTION_HINT =
  "(Rocket.Chat: to react to the user's message with an emoji, include [react: 👍] in your reply — it is applied as a reaction and removed from the text. A reply that is only a marker posts no message. Use it for acknowledgements that need no words.)";
