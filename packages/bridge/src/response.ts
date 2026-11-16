
// What the agent actually did in a turn.
//
// Keeping only the `type === "message"` items of `output[]` would throw away
// every tool the agent called, and "did it actually call that tool?" would be
// unanswerable: not for lack of data, but because it was discarded on arrival.
//
// Verified against the gateway this was built on:
// the non-streaming `output[]` contains EXACTLY three item types —
//   function_call        {name, arguments (a JSON *string*), call_id}
//   function_call_output {call_id, output}
//   message              {role, content:[{type:"output_text", text}]}
// There is no `reasoning` item — the gateway does not expose thinking over HTTP.
// So a full tool trace needs no streaming and no protocol change; it is already
// sitting in the response we get today.

/** Token counts off a response's `usage`, for a usage ledger. */
export interface TokenUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Token counts in either wire shape the gateway sends (Responses or Chat
 * Completions), bare or under `usage`; null when neither count is there. */
export function usageFrom(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const u = (b.usage && typeof b.usage === "object" ? b.usage : b) as Record<string, unknown>;
  const tokensIn = int(u.input_tokens) ?? int(u.prompt_tokens) ?? int(u.inputTokens);
  const tokensOut = int(u.output_tokens) ?? int(u.completion_tokens) ?? int(u.outputTokens);
  if (tokensIn === null && tokensOut === null) return null;
  const details = (u.input_tokens_details ?? u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const tokensCached = int(details.cached_tokens) ?? int(u.cached_tokens) ?? int(u.cachedInputTokens);
  return { tokensIn, tokensOut, tokensCached };
}

/** One tool the agent called, paired with its result when we can match one. */
export interface ToolCall {
  name: string;
  /** A short, truncated look at the arguments — enough to tell
   * `search_notes(query:"invoices")` from a different search, without
   * copying whole file contents into the trace. */
  args?: string;
  /** Size of a successful tool result. Successful output remains a count so
   * traces do not become a second copy of every message. */
  outputChars?: number;
  /** A failed tool result's text, RAW: whoever persists it redacts and bounds it
   * (a tracing plugin does, before the row is written). */
  error?: string;
}

export interface ResponseSummary {
  text: string;
  tools: ToolCall[];
  /** The response's own id, the ledger's idempotency key for this turn. */
  id?: string;
  /** The model the gateway reports having served the turn. */
  model?: string;
  /** Token counts off the response's `usage`, when the gateway stamped one. */
  usage?: TokenUsage;
  /** Item types we didn't recognise. Logged rather than ignored, so a gateway
   * upgrade that adds a type shows up as a line in the log instead of silently
   * vanishing the way the tool calls did. */
  unknownTypes: string[];
}

/** How much of a tool's arguments to keep. Long enough to identify the call,
 * short enough that a file-write's payload doesn't land in the database. */
const MAX_ARGS_PREVIEW = 200;

interface OutputItem {
  type?: string;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  is_error?: boolean;
  isError?: boolean;
  status?: string;
  error?: unknown;
  output?: unknown;
  content?: unknown;
  role?: string;
}

/** Collapse a tool's arguments to a compact preview. `arguments` arrives as a
 * JSON *string*; when it parses we re-render it compactly (dropping whitespace
 * the model emitted), and when it doesn't we keep the raw string rather than
 * losing it. */
export function previewArgs(raw: unknown, max = MAX_ARGS_PREVIEW): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let text: string;
  if (typeof raw === "string") {
    try {
      text = JSON.stringify(JSON.parse(raw));
    } catch {
      text = raw;
    }
  } else {
    text = JSON.stringify(raw);
  }
  text = text.trim();
  if (!text || text === "{}") return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A failed tool result as text: a string as-is, anything else as JSON. */
export function errorText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return undefined;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function outputLength(output: unknown): number | undefined {
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) {
    return output.reduce<number>(
      (n, part) => n + (typeof (part as { text?: string })?.text === "string" ? (part as { text: string }).text.length : 0),
      0,
    );
  }
  return undefined;
}

/** Split a /v1/responses body into the reply text and the trace of what it took
 * to produce it. Never throws — a malformed body yields empty text, which the
 * caller already handles as "(no reply)". */
export function summarizeResponse(body: unknown): ResponseSummary {
  const output = (body as { output?: unknown })?.output;
  const head = body as { id?: unknown; model?: unknown } | null;
  const usage = usageFrom(body);
  const ident = {
    ...(typeof head?.id === "string" && head.id ? { id: head.id } : {}),
    ...(typeof head?.model === "string" && head.model ? { model: head.model } : {}),
    ...(usage ? { usage } : {}),
  };
  const empty: ResponseSummary = { text: "", tools: [], unknownTypes: [], ...ident };
  if (!Array.isArray(output)) return empty;

  const parts: string[] = [];
  const tools: ToolCall[] = [];
  const unknownTypes: string[] = [];
  // call_id → index in `tools`, so a result can be attached to the call it
  // belongs to rather than to whichever call happened to be last.
  const byCallId = new Map<string, number>();

  for (const item of output as OutputItem[]) {
    switch (item?.type) {
      case "message": {
        if (!Array.isArray(item.content)) break;
        for (const c of item.content as Array<{ type?: string; text?: string }>) {
          if (c?.type === "output_text" && c.text) parts.push(c.text);
        }
        break;
      }
      case "function_call": {
        const name = typeof item.name === "string" && item.name ? item.name : "(unnamed tool)";
        if (item.call_id) byCallId.set(item.call_id, tools.length);
        tools.push({ name, args: previewArgs(item.arguments) });
        break;
      }
      case "function_call_output": {
        const at = item.call_id ? byCallId.get(item.call_id) : undefined;
        const failed = item.is_error === true || item.isError === true || item.status === "error" || item.error !== undefined;
        if (failed) {
          const error = errorText(item.error ?? item.output)?.trim() || undefined;
          if (at !== undefined && tools[at]) tools[at].error = error;
          else tools.push({ name: "(unmatched result)", ...(error ? { error } : {}) });
          break;
        }
        const chars = outputLength(item.output);
        // A result with no matching call still counts as evidence of a tool
        // running, so it's recorded rather than dropped.
        if (at !== undefined && tools[at]) tools[at].outputChars = chars;
        else tools.push({ name: "(unmatched result)", outputChars: chars });
        break;
      }
      default:
        if (item?.type) unknownTypes.push(item.type);
    }
  }

  return { text: parts.join("\n").trim(), tools, unknownTypes, ...ident };
}

/** One log line naming what the turn actually did — `search_notes×3`
 * style, with result sizes, so a search that found nothing is visible as such. */
export function describeTools(tools: ToolCall[]): string {
  if (!tools.length) return "no tools called";
  const counts = new Map<string, { n: number; chars: number }>();
  for (const t of tools) {
    const at = counts.get(t.name) ?? { n: 0, chars: 0 };
    at.n += 1;
    at.chars += t.outputChars ?? 0;
    counts.set(t.name, at);
  }
  return [...counts]
    .map(([name, { n, chars }]) => `${name}${n > 1 ? `×${n}` : ""} (${chars} chars back)`)
    .join(", ");
}
