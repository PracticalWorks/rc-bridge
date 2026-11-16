/** The deadline passed before the response headers arrived. Typed so a caller
 * classifies a timeout by what it is, never by matching the message text. */
export class DeadlineError extends Error {
  readonly code = "deadline";
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "DeadlineError";
  }
}

/** fetch with a hard deadline. On timeout it throws a DeadlineError, because
 * undici's raw AbortError only says "This operation was aborted". A transport
 * error that is not the deadline passes through as it is. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new DeadlineError(label, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
