// The agent client, for an OpenAI-compatible Responses endpoint: one request
// builder for both the plain and the streamed turn, the silence watchdog, and a
// reader for GET /v1/runs/{id}. The "never abort mid-stream" rule lives here whole.
import { buildAgentInput, type InlineImage } from "./attachments.js";
import { summarizeResponse, type ResponseSummary } from "./response.js";
import { createSseParser, formatCensus, readSseEvent } from "./stream.js";
import type { Log } from "./config.js";
import { DeadlineError, fetchWithTimeout } from "@practicalworks/rc-client";

/** Where a turn goes: one gateway profile. */
export interface AgentTarget {
  url: string;
  apiKey: string;
  model: string;
}

/** ms from the request start; null when never seen (a non-streaming reply). */
export interface AgentTimings {
  firstEventMs: number | null;
  firstTextMs: number | null;
  totalMs: number;
}

export type AgentTurn = ResponseSummary & { timings: AgentTimings };

/** What a park check learned about the run behind a silent stream. */
export type ParkVerdict = "parked" | "running" | "unknown";

/** One read of a run: the subset of a run's state the park check uses. `parked` is present only when true. */
export type RunRead =
  | { ok: true; done: boolean; status: string; runId: string; parked?: true; createdAt?: string; lastEvent?: string }
  | { ok: false; error: string; expired?: boolean };

export interface AgentClientOptions {
  timeoutMs: number;
  parkCheckMs: number;
  /** RC_STREAMING; false forces the plain path outright. */
  streaming: boolean;
  log: Log;
  fetchImpl?: typeof fetch;
}

/** The deadline labels of the turn request itself, plain and streamed. */
const TURN_LABEL = "Agent /v1/responses";
const STREAM_TURN_LABEL = "Agent /v1/responses (stream)";

/** Did the turn's own request pass its deadline? Not a failure: the gateway keeps
 * working after we hang up, and the named conversation keeps its state. */
export function isTurnTimeout(err: unknown): boolean {
  return err instanceof DeadlineError && (err.label === TURN_LABEL || err.label === STREAM_TURN_LABEL);
}

/** The agent answered the turn with a non-2xx status. `status` is the fact a
 * caller branches on; the message keeps the first 500 characters of the body for
 * the log, and is never posted to a room as-is. */
export class AgentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

/** The agent accepted the turn and then reported the run failed on the stream. */
export class AgentRunFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunFailedError";
  }
}

/** Run states the gateway will not move off. */
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "canceled"]);
/** Not terminal, but will never advance: a person must act. Only the
 * state actually observed on the wire is listed. */
const PARKED_RUN_STATES = new Set(["waiting_for_approval"]);
const RUN_READ_TIMEOUT_MS = 30_000;

const isTerminalRunStatus = (s: string) => TERMINAL_RUN_STATES.has(s.trim().toLowerCase());
const isParkedRunStatus = (s: string) => PARKED_RUN_STATES.has(s.trim().toLowerCase());

/** Sentinel for "nothing arrived within the window" — never a chunk. */
const IDLE = Symbol("idle");

/** Await `pending` for at most `ms`, then hand back IDLE. The promise itself is
 * untouched — the caller keeps awaiting it — so this can never cancel a read. */
function raceIdle<T>(pending: Promise<T>, ms: number): Promise<T | typeof IDLE> {
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<typeof IDLE>((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
  });
  return Promise.race([pending, idle]).finally(() => clearTimeout(timer));
}

export function createAgentClient(opts: AgentClientOptions) {
  const { log, timeoutMs, parkCheckMs } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  /** Whether the gateway streams; undefined until it has answered once. Detected
   * from the response's content-type, never from a guessed capabilities shape. */
  let streamingSupported: boolean | undefined;

  /** The ONE Responses request. With no images `input` is a bare string; with
   * images it is the content-part form the gateway accepts for vision. */
  async function postResponses(
    target: AgentTarget,
    conversation: string,
    prompt: string,
    images: InlineImage[],
    stream: boolean,
  ): Promise<Response> {
    const res = await fetchWithTimeout(
      `${target.url}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(stream ? { accept: "text/event-stream" } : {}),
          authorization: `Bearer ${target.apiKey}`,
        },
        body: JSON.stringify({
          model: target.model,
          input: buildAgentInput(prompt, images),
          store: true,
          conversation,
          ...(stream ? { stream: true } : {}),
        }),
      },
      stream ? STREAM_TURN_LABEL : TURN_LABEL,
      timeoutMs,
      fetchImpl,
    );
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      // A 400 on an image turn means this gateway no longer takes inline images.
      // Fail loudly: retrying as text would read as if the agent saw the screenshot.
      if (images.length && res.status === 400) {
        throw new AgentHttpError(
          400,
          `The agent rejected the image (400) — this gateway build may not support inline image input on /v1/responses. Detail: ${detail}`,
        );
      }
      throw new AgentHttpError(res.status, `Agent /v1/responses returned ${res.status}: ${detail}`);
    }
    return res;
  }

  const plainTimings = (startedAt: number): AgentTimings => ({
    firstEventMs: null,
    firstTextMs: null,
    totalMs: Date.now() - startedAt,
  });

  /** One turn inside a named conversation, which the gateway auto-chains
   * server-side: no response ids to track, and a gateway restart keeps it. */
  async function ask(
    target: AgentTarget,
    conversation: string,
    prompt: string,
    images: InlineImage[] = [],
  ): Promise<AgentTurn> {
    const startedAt = Date.now();
    const res = await postResponses(target, conversation, prompt, images, false);
    return { ...summarizeResponse(await res.json()), timings: plainTimings(startedAt) };
  }

  /** The same turn, streamed. The stream carries the run's handle for the
   * park check and the event census; its text is never shown live, since
   * RC notifies on creation and not on edits.
   *
   *  - **Never abort mid-stream.** Disconnecting CANCELS the run on the gateway.
   *    The timeout bounds time to FIRST BYTE only.
   *  - **Never trust the stream for the trace.** `summarizeResponse` reads the tool
   *    calls from the completion event; with no completion, fall back to the
   *    accumulated text rather than losing the turn.
   */
  async function askStreaming(
    target: AgentTarget,
    conversation: string,
    prompt: string,
    images: InlineImage[],
    onCreated?: (responseId: string) => void,
    // Called with the run's handle once the stream has been silent for
    // parkCheckMs. `running` keeps watching; anything else stops the checks.
    onParkCheck?: (responseId: string) => Promise<ParkVerdict>,
  ): Promise<AgentTurn> {
    const requestStartedAt = Date.now();
    const res = await postResponses(target, conversation, prompt, images, true);

    // Did we actually get a stream? The response itself is the feature detection.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      if (streamingSupported !== false) {
        log(`gateway answered ${contentType || "(no content-type)"} rather than SSE — using non-streaming replies`);
      }
      streamingSupported = false;
      // Not an error: this IS the ordinary reply, parsed exactly as before.
      return { ...summarizeResponse(await res.json()), timings: plainTimings(requestStartedAt) };
    }
    if (streamingSupported === undefined) log("streaming enabled — reading the run live (text is posted once, finished)");
    streamingSupported = true;
    if (!res.body) throw new Error("The agent returned no stream body");

    const parser = createSseParser();
    const decoder = new TextDecoder();
    let accumulated = "";
    let completed: unknown;
    let streamError: string | undefined;
    // The run's handle, from `response.created` — the only thing naming the run.
    let responseId: string | undefined;
    const streamStartedAt = Date.now();
    let firstDeltaAt: number | undefined;
    let deltaCount = 0;
    // Every event type the gateway sent, counted, including ones we ignore.
    const census = new Map<string, number>();
    // ANYTHING arriving vs TEXT arriving: far apart means only the text is late.
    let firstEventAt: number | undefined;

    const handle = (events: ReturnType<typeof parser.push>) => {
      for (const evt of events) {
        const { type, signal } = readSseEvent(evt);
        census.set(type, (census.get(type) ?? 0) + 1);
        firstEventAt ??= Date.now();
        if (signal.kind === "created") {
          responseId ??= signal.id;
          onCreated?.(responseId);
        } else if (signal.kind === "delta") {
          firstDeltaAt ??= Date.now();
          deltaCount++;
          accumulated += signal.text;
        } else if (signal.kind === "completed") {
          completed = signal.response;
        } else if (signal.kind === "error") {
          streamError = signal.message;
        }
      }
    };

    // No timeout around the read loop — see above. What there IS: a
    // silence watchdog that never touches the socket. After parkCheckMs of
    // nothing, ask the gateway (separate GET) whether the run parked; the pending
    // read is kept and awaited again, so the stream is consumed to its end.
    const chunks = (res.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<Uint8Array>> | undefined;
    let watching = Boolean(onParkCheck);
    for (;;) {
      pending ??= chunks.next();
      const next = watching ? await raceIdle(pending, parkCheckMs) : await pending;
      if (next === IDLE) {
        if (!responseId) {
          // `response.created` is the first event; none by now means nothing to ask about.
          log(`park check: stream silent ${parkCheckMs}ms and no response.created id — cannot check this run`);
          watching = false;
          continue;
        }
        const verdict = await onParkCheck!(responseId);
        log(`park check: /v1/runs/${responseId} → ${verdict}`);
        if (verdict !== "running") watching = false;
        continue;
      }
      pending = undefined;
      if (next.done) break;
      handle(parser.push(decoder.decode(next.value, { stream: true })));
    }
    handle(parser.flush());

    // Say what was measured, not what it means: `first event` far below `first
    // text` means the gateway talks the whole time and only the TEXT is late.
    const at = (t: number | undefined) => (t ? `${t - streamStartedAt}ms` : "never");
    log(
      `stream: ${formatCensus(census)} | ${deltaCount} text delta(s), ` +
        `first event at ${at(firstEventAt)}, first text at ${at(firstDeltaAt)}, ` +
        `done at ${Date.now() - streamStartedAt}ms`,
    );
    const sinceRequest = (t: number | undefined) => (t === undefined ? null : t - requestStartedAt);
    const timings: AgentTimings = {
      firstEventMs: sinceRequest(firstEventAt),
      firstTextMs: sinceRequest(firstDeltaAt),
      totalMs: Date.now() - requestStartedAt,
    };
    if (streamError) throw new AgentRunFailedError(`Agent stream failed: ${streamError}`);
    if (completed) {
      const summary = summarizeResponse(completed);
      // Prefer the completion's own text; fall back to the accumulated deltas.
      return summary.text ? { ...summary, timings } : { ...summary, text: accumulated, timings };
    }
    return { text: accumulated, tools: [], unknownTypes: [], timings };
  }

  /** One GET of a run. A PLAIN GET — nothing held open, the stream never touched. */
  async function getRun(target: AgentTarget, runId: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status?: number }> {
    const base = target.url.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${base}/v1/runs/${encodeURIComponent(runId)}`,
        // Never follow a redirect: a followed Access 302 is a 200 of HTML.
        { method: "GET", redirect: "manual", headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}` } },
        "Agent /v1/runs",
        RUN_READ_TIMEOUT_MS,
        fetchImpl,
      );
    } catch (err) {
      return { ok: false, error: `Could not reach the agent at ${base}: ${(err as Error)?.message ?? err}` };
    }
    const text = await res.text();
    if (!res.ok || (res.status >= 300 && res.status < 400)) {
      return { ok: false, error: `Agent /v1/runs returned ${res.status}: ${text.slice(0, 300)}`, status: res.status };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, error: `The agent returned non-JSON: ${text.slice(0, 200)}` };
    }
  }

  /** Read a run's state for the park check. A parked status is read twice: the
   * first GET can briefly show the pre-approval snapshot. */
  async function readRun(target: AgentTarget, runId: string): Promise<RunRead> {
    let res = await getRun(target, runId);
    if (!res.ok) {
      return res.status === 404
        ? { ok: false, error: `Agent run \`${runId}\` expired before it was resolved.`, expired: true }
        : { ok: false, error: res.error };
    }
    type RunBody = { status?: unknown; created_at?: unknown; last_event?: unknown } | undefined;
    if (isParkedRunStatus(String((res.body as RunBody)?.status ?? "unknown"))) {
      const confirmed = await getRun(target, runId);
      if (confirmed.ok) res = confirmed;
    }
    const body = res.body as RunBody;
    const status = String(body?.status ?? "unknown");
    const metadata = {
      ...(typeof body?.created_at === "string" ? { createdAt: body.created_at } : {}),
      ...(typeof body?.last_event === "string" ? { lastEvent: body.last_event } : {}),
    };
    if (isTerminalRunStatus(status)) return { ok: true, done: true, status, runId, ...metadata };
    return isParkedRunStatus(status)
      ? { ok: true, done: false, status, runId, parked: true, ...metadata }
      : { ok: true, done: false, status, runId, ...metadata };
  }

  return {
    ask,
    askStreaming,
    readRun,
    /** RC_STREAMING is on and the gateway has not answered in plain JSON. */
    shouldTryStreaming: () => opts.streaming && streamingSupported !== false,
  };
}
