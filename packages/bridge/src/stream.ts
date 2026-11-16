
// Reading the agent's /v1/responses SSE stream.
//
// The bridge streams for what only a stream gives: the run's handle for the park
// check and a census of every event type. Text is NOT shown live — RC
// notifies on a message's creation, never its edits, so replies post once,
// finished. Too-large replies are split by the client's `splitForRc`.
//
// Kept apart from main.ts so the parsing is unit-testable.

/** A parsed SSE event. `data` is the raw JSON string; callers decode it. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser.
 *
 * Chunks off a socket split anywhere — mid-line, mid-JSON, between the `event:`
 * and its `data:`. So this buffers and only emits on a complete blank-line
 * delimited record.
 */
export function createSseParser(): { push(chunk: string): SseEvent[]; flush(): SseEvent[] } {
  let buffer = "";

  const parseRecord = (record: string): SseEvent | null => {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of record.split("\n")) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join("\n") };
  };

  return {
    push(chunk) {
      buffer += chunk;
      const out: SseEvent[] = [];
      let idx: number;
      // Records are separated by a blank line. \r\n tolerated.
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + buffer.slice(idx).match(/^\r?\n\r?\n/)![0].length);
        const parsed = parseRecord(record);
        if (parsed) out.push(parsed);
      }
      return out;
    },
    // A stream that ends without a trailing blank line still has one record in
    // hand; losing it would silently drop the last of the answer.
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (!rest) return [];
      const parsed = parseRecord(rest);
      return parsed ? [parsed] : [];
    },
  };
}

/** What a decoded stream event meant to us. */
export type StreamSignal =
  /** `response.created` — the run's handle, sent before any text. The
   *  only thing on the stream that names the run, so it is the only way the
   *  bridge can later ask the gateway whether that run parked. */
  | { kind: "created"; id: string }
  | { kind: "delta"; text: string }
  | { kind: "completed"; response: unknown }
  | { kind: "error"; message: string }
  | { kind: "done" }
  | { kind: "ignored" };

/**
 * Interpret one SSE event.
 *
 * Deliberately tolerant about which field carries the text: this gateway is
 * OpenAI-compatible but we have been burned before by assuming a payload shape
 * from a spec rather than from the wire. Anything unrecognised is `ignored`
 * rather than fatal — an unknown event type must never sink a turn that is
 * otherwise succeeding.
 */
export function interpretSseEvent(evt: SseEvent): StreamSignal {
  return readSseEvent(evt).signal;
}

/**
 * The same interpretation, plus the event's own type NAME.
 *
 * Exists so a caller can take a census of what the gateway actually sends.
 * `interpretSseEvent` collapses everything it doesn't act on into
 * `ignored`, which is right for driving a reply and useless for measuring one:
 * counting only what we consume is how "2 deltas" got read as "the gateway
 * buffers", when `response.output_item.added` — the function_call events
 * carrying live tool activity — were streaming past uncounted the whole time.
 *
 * The type is resolved here rather than by re-parsing at the call site, so the
 * census and the behaviour can never disagree about what an event was.
 */
export function readSseEvent(evt: SseEvent): { type: string; signal: StreamSignal } {
  if (evt.data === "[DONE]") return { type: "[DONE]", signal: { kind: "done" } };
  let parsed: {
    type?: string;
    delta?: unknown;
    text?: string;
    response?: unknown;
    error?: unknown;
    id?: unknown;
  };
  try {
    parsed = JSON.parse(evt.data);
  } catch {
    // Still worth naming: a stream full of unparseable records is a finding, and
    // an empty census row would hide it.
    return { type: evt.event ?? "(unparseable)", signal: { kind: "ignored" } };
  }
  const type = parsed.type ?? evt.event ?? "(untyped)";
  const as = (signal: StreamSignal) => ({ type, signal });

  if (type === "response.created") {
    // The id rides on the response object in the OpenAI shape and at the top
    // level in some gateway builds; take whichever is there, and say `ignored`
    // rather than inventing a handle when neither is.
    const inner = (parsed.response as { id?: unknown } | undefined)?.id;
    const id = typeof inner === "string" ? inner : typeof parsed.id === "string" ? parsed.id : "";
    return as(id ? { kind: "created", id } : { kind: "ignored" });
  }
  if (type.endsWith("output_text.delta") || type === "response.text.delta") {
    const text = typeof parsed.delta === "string" ? parsed.delta : typeof parsed.text === "string" ? parsed.text : "";
    return as(text ? { kind: "delta", text } : { kind: "ignored" });
  }
  if (type === "response.completed" || type === "response.done") {
    return as({ kind: "completed", response: parsed.response ?? parsed });
  }
  if (type === "response.failed" || type === "error" || parsed.error) {
    const err = parsed.error as { message?: string } | undefined;
    return as({ kind: "error", message: err?.message ?? "the agent reported a failed response" });
  }
  return as({ kind: "ignored" });
}

/** Render an event census smallest-key-first as `type=count`, for one log line. */
export function formatCensus(census: Map<string, number>): string {
  return [...census.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${type}=${n}`)
    .join(" ");
}
