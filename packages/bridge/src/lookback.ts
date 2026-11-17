// The sender's recent, untagged image uploads, for an addressed channel message
// that carries none: "@bot remind me about that" after posting an
// image without tagging. A DM needs none of this: every upload there got its own turn.
import {
  attachmentsOf,
  captionOf,
  isImageType,
  type AttachmentDeps,
  type InlineImage,
  type RcMessage,
  type SkippedImage,
} from "./attachments.js";
import { botFaces, mentionsUs, type BotIdentity } from "./threading.js";

/** How many messages the one history call asks for; the window is the real bound. */
export const LOOKBACK_COUNT = 50;

export interface LookbackRequest {
  roomId: string;
  /** RC's room type (`c` public, `p` private); anything else has no lookback. */
  roomType: string | undefined;
  senderId: string | undefined;
  senderName: string | undefined;
  /** The addressed message itself, never its own lookback. */
  messageId: string | undefined;
  /** Scope: this thread's replies, or top-level messages when undefined. */
  tmid: string | undefined;
  windowMs: number;
  budget: number;
  now: number;
  bot: BotIdentity;
}

/** The history endpoint for a room type, or undefined for rooms that have none here. */
export function historyEndpoint(roomType: string | undefined): string | undefined {
  return roomType === "c" ? "channels.history" : roomType === "p" ? "groups.history" : undefined;
}

/** Did this message already reach us? Then it was answered with its image. */
function addressedUs(m: RcMessage, bot: BotIdentity): boolean {
  const faces = new Set(botFaces(bot));
  const named = (m.mentions ?? []).some((x) => x._id === bot.userId || faces.has((x.username ?? "").toLowerCase()));
  return named || mentionsUs(captionOf(m), bot);
}

/** Which history messages are the sender's own untagged images, in scope and
 * in the window, oldest first. RC lists newest first; the newest win the budget. */
export function recentImageMessages(messages: readonly RcMessage[], req: LookbackRequest): RcMessage[] {
  const since = req.now - req.windowMs;
  const picked = messages.filter((m) => {
    const bySender = req.senderId && m.u?._id ? m.u._id === req.senderId : !!req.senderName && m.u?.username === req.senderName;
    if (!bySender || (req.messageId && m._id === req.messageId)) return false;
    if ((m.tmid ?? undefined) !== req.tmid) return false;
    const at = Date.parse(m.ts ?? "");
    if (!Number.isNaN(at) && at < since) return false;
    if (addressedUs(m, req.bot)) return false;
    return (m.attachments ?? []).some((a) => isImageType(a.image_type ?? m.file?.type));
  });
  return picked
    .sort((a, b) => Date.parse(b.ts ?? "") - Date.parse(a.ts ?? ""))
    .slice(0, req.budget)
    .reverse();
}

export interface RecentImages {
  images: InlineImage[];
  skipped: SkippedImage[];
}

/** ONE history call, then the chosen images downloaded as the room's identity.
 * Never throws; `undefined` when there is no lookback for this room or it failed. */
export async function fetchRecentImages(deps: AttachmentDeps, req: LookbackRequest): Promise<RecentImages | undefined> {
  const endpoint = historyEndpoint(req.roomType);
  if (!endpoint || req.budget <= 0 || req.windowMs <= 0) return undefined;
  const query = new URLSearchParams({
    roomId: req.roomId,
    oldest: new Date(req.now - req.windowMs).toISOString(),
    count: String(LOOKBACK_COUNT),
  });
  // RC documents showThreadMessages on channels.history without stating its
  // default, so a threaded lookback asks for replies explicitly rather than
  // relying on it. groups.history does not document the param, so it is not sent.
  if (req.tmid && endpoint === "channels.history") query.set("showThreadMessages", "true");
  let messages: RcMessage[];
  try {
    const res = await deps.get(`${deps.rcUrl}/api/v1/${endpoint}?${query}`, deps.headers);
    if (!res.ok) {
      deps.log?.(`${endpoint} ${req.roomId} failed: ${res.status}`);
      return undefined;
    }
    messages = ((await res.json()) as { messages?: RcMessage[] }).messages ?? [];
  } catch (err) {
    deps.log?.(`${endpoint} ${req.roomId} threw: ${(err as Error)?.message ?? err}`);
    return undefined;
  }
  const images: InlineImage[] = [];
  const skipped: SkippedImage[] = [];
  for (const m of recentImageMessages(messages, req)) {
    const budget = req.budget - images.length;
    if (budget <= 0) break;
    const got = await attachmentsOf(deps, m, { budget, imagesOnly: true });
    images.push(...got.images);
    skipped.push(...got.skipped);
  }
  return { images, skipped };
}

/** The one line that tells the agent these images were not on this message. */
export function lookbackNote(count: number, windowMs: number): string {
  const what = count === 1 ? "The attached image is" : `The ${count} attached images are`;
  return `(${what} from your recent messages here, posted in the last ${Math.round(windowMs / 60_000)} min without tagging me — not from this message.)`;
}
