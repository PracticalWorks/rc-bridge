// What every attachment read needs, for one room, built from a Rocket.Chat
// client: the room's auth headers and the client's deadline-bound GET. The
// client knows nothing about attachments; the limits and the resizer are the
// bridge's.
import type { RocketChatClient } from "@practicalworks/rc-client";
import type { AttachmentDeps, AttachmentLimits, ImageResizer } from "./attachments.js";
import type { Log } from "./config.js";

export interface AttachmentDepsOptions {
  rc: Pick<RocketChatClient, "headersForRoom" | "get">;
  /** The Rocket.Chat base URL that upload links are relative to. */
  rcUrl: string;
  limits: AttachmentLimits;
  /** Shrinks or converts an image the limits would skip; absent, it is skipped. */
  resizeImage?: ImageResizer;
  log: Log;
}

/** Reads run as the ROOM's identity, not the bot's: an account that speaks in a
 * room for the bot can read uploads there that the bot itself cannot. */
export function createAttachmentDeps(opts: AttachmentDepsOptions): (roomId: string) => Promise<AttachmentDeps> {
  const { rc, rcUrl, limits, resizeImage, log } = opts;
  return async (roomId) => ({
    rcUrl,
    headers: await rc.headersForRoom(roomId),
    get: (url, headers) => rc.get(url, headers, "Rocket.Chat attachment"),
    limits,
    ...(resizeImage ? { resizeImage } : {}),
    log,
  });
}
