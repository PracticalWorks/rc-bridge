/**
 * A Rocket.Chat REST failure with the HTTP status and Rocket.Chat's
 * machine-readable `error` code as fields, so callers branch on the kind of
 * failure instead of parsing the message string.
 */
export class RocketChatApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly rcError: string | undefined,
    public readonly body: string,
  ) {
    super(`Rocket.Chat API error ${status} on ${endpoint}: ${body.slice(0, 300)}`);
    this.name = "RocketChatApiError";
  }
}

/**
 * A post Rocket.Chat rejected, carrying WHY as a field rather than leaving it to
 * be read back out of the message text. Only `unknownRoom` may trigger the
 * display-name fallback, so it is precisely the fact that must not be forgeable
 * by arbitrary server text quoted into the message.
 */
export class RocketChatPostError extends RocketChatApiError {
  /** True only when Rocket.Chat itself classified the failure as "no such room". */
  readonly unknownRoom: boolean;

  constructor(message: string, options: { unknownRoom: boolean; status?: number; rcError?: string }) {
    super(options.status ?? 0, "chat.postMessage", options.rcError, message);
    this.name = "RocketChatPostError";
    this.message = message;
    this.unknownRoom = options.unknownRoom;
  }
}

/** Rocket.Chat's own names for "no such room", across the two error shapes it
 * uses: a bracketed `error` on some routes, a typed `errorType` on others. */
const UNKNOWN_ROOM_ERRORS = new Set(["invalid-channel", "error-room-not-found"]);

/** The JSON body Rocket.Chat returns when it refuses a call. */
export interface RocketChatErrorBody {
  success?: boolean;
  error?: string;
  errorType?: string;
}

/**
 * Parse an error body WITHOUT trusting it to be JSON. A proxy in front of
 * Rocket.Chat answers an outage with an HTML page, and an unguarded parse there
 * throws a SyntaxError that buries the status worth reporting.
 */
export function parseErrorBody(text: string): RocketChatErrorBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as RocketChatErrorBody) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did Rocket.Chat's OWN error field name an unknown room?
 *
 * Read from the parsed `error`/`errorType` fields and compared WHOLE, never
 * searched for inside a rendered message. The message embeds up to 300 characters
 * of a server-controlled body, so a substring test over it is satisfied by any
 * failure that merely quotes the token: a 401, a 403, or a proxy's HTML error
 * page. Rocket.Chat brackets the value on some routes and not on others, so the
 * brackets come off before the comparison.
 */
export function namesUnknownRoom(body: RocketChatErrorBody | undefined): boolean {
  return [body?.errorType, body?.error].some(
    (value) =>
      typeof value === "string" &&
      UNKNOWN_ROOM_ERRORS.has(value.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase()),
  );
}
