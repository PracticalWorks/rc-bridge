
import { createSseParser } from "./stream.js";

export interface ApprovalDetails {
  command?: string;
  choices?: string[];
}

/** Extract the approval payload without depending on one gateway event wrapper. */
export function approvalDetailsFromEvent(value: unknown): ApprovalDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const nested = [object, object.data, object.event, object.payload, object.details]
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object"));
  for (const candidate of nested) {
    const command = [candidate.command, candidate.command_text, candidate.tool, candidate.name].find(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    const rawChoices = candidate.choices ?? candidate.options ?? candidate.allowed;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : undefined;
    if (command || choices?.length) return { ...(command ? { command: command.trim() } : {}), ...(choices?.length ? { choices } : {}) };
  }
  return undefined;
}

export interface RunEventCapture {
  command?: string;
  choices?: string[];
  snapshot(): ApprovalDetails;
  close(): void;
}

/** Subscribe to a run's non-destructive event feed. The caller owns close(). */
export function captureRunEvents(options: {
  url: string;
  apiKey: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): RunEventCapture {
  const controller = new AbortController();
  let command: string | undefined;
  let choices: string[] | undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  void (async () => {
    try {
      const response = await fetchImpl(`${options.url}/v1/runs/${encodeURIComponent(options.runId)}/events`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${options.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;
      const parser = createSseParser();
      const decoder = new TextDecoder();
      const consume = (events: ReturnType<typeof parser.push>) => {
        for (const event of events) {
          if (event.data === "[DONE]") continue;
          try {
            const details = approvalDetailsFromEvent(JSON.parse(event.data));
            if (details?.command) command = details.command;
            if (details?.choices?.length) choices = details.choices;
          } catch {
            // An unrelated or malformed event must not affect the turn.
          }
        }
      };
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        consume(parser.push(decoder.decode(chunk, { stream: true })));
      }
      consume(parser.flush());
    } catch {
      // Best effort: the approval path still sends a status-only DM if this feed fails.
    }
  })();
  return {
    snapshot: () => ({ ...(command ? { command } : {}), ...(choices ? { choices } : {}) }),
    close: () => controller.abort(),
  };
}
