import { describe, expect, it } from "vitest";
import { createSseParser, formatCensus, interpretSseEvent, readSseEvent } from "./stream.js";

const delta = (t: string) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: t })}\n\n`;

describe("createSseParser", () => {
  it("emits one event per record", () => {
    const p = createSseParser();
    const events = p.push(delta("Hello") + delta(" world"));
    expect(events).toHaveLength(2);
    expect(interpretSseEvent(events[0]!)).toEqual({ kind: "delta", text: "Hello" });
  });

  it("buffers a record split across chunks", () => {
    // The case that matters: sockets split wherever they like, including
    // mid-JSON. A parser that assumed whole records would lose text.
    const p = createSseParser();
    const whole = delta("streamed");
    expect(p.push(whole.slice(0, 12))).toEqual([]);
    const rest = p.push(whole.slice(12));
    expect(rest).toHaveLength(1);
    expect(interpretSseEvent(rest[0]!)).toEqual({ kind: "delta", text: "streamed" });
  });

  it("handles an event: line preceding its data:", () => {
    const p = createSseParser();
    const [evt] = p.push('event: response.completed\ndata: {"response":{"output":[]}}\n\n');
    expect(evt!.event).toBe("response.completed");
    expect(interpretSseEvent(evt!).kind).toBe("completed");
  });

  it("ignores comment/keep-alive lines", () => {
    const p = createSseParser();
    expect(p.push(": keep-alive\n\n")).toEqual([]);
  });

  it("tolerates CRLF", () => {
    const p = createSseParser();
    const events = p.push('data: {"type":"response.output_text.delta","delta":"x"}\r\n\r\n');
    expect(events).toHaveLength(1);
  });

  it("flush() returns a trailing record with no blank line after it", () => {
    // A stream that ends abruptly still has the last of the answer in hand.
    const p = createSseParser();
    expect(p.push('data: {"type":"response.output_text.delta","delta":"tail"}')).toEqual([]);
    const flushed = p.flush();
    expect(interpretSseEvent(flushed[0]!)).toEqual({ kind: "delta", text: "tail" });
  });

  it("joins multi-line data fields", () => {
    const p = createSseParser();
    const [evt] = p.push("data: {\ndata: \"a\": 1}\n\n");
    expect(evt!.data).toBe('{\n"a": 1}');
  });
});

describe("interpretSseEvent", () => {
  it("reads a text delta", () => {
    expect(interpretSseEvent({ data: JSON.stringify({ type: "response.output_text.delta", delta: "hi" }) })).toEqual({
      kind: "delta",
      text: "hi",
    });
  });

  it("accepts the alternate delta field name", () => {
    expect(interpretSseEvent({ data: JSON.stringify({ type: "response.text.delta", text: "hi" }) })).toEqual({
      kind: "delta",
      text: "hi",
    });
  });

  it("hands back the full response object on completion", () => {
    const response = { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] };
    expect(interpretSseEvent({ data: JSON.stringify({ type: "response.completed", response }) })).toEqual({
      kind: "completed",
      response,
    });
  });

  it("recognises the [DONE] sentinel", () => {
    expect(interpretSseEvent({ data: "[DONE]" })).toEqual({ kind: "done" });
  });

  it("surfaces an error event with its message", () => {
    const sig = interpretSseEvent({ data: JSON.stringify({ type: "error", error: { message: "quota gone" } }) });
    expect(sig).toEqual({ kind: "error", message: "quota gone" });
  });

  it("ignores unknown event types instead of failing the turn", () => {
    // An unrecognised event must never sink a run that is otherwise succeeding.
    expect(interpretSseEvent({ data: JSON.stringify({ type: "response.some_future_thing" }) })).toEqual({
      kind: "ignored",
    });
  });

  it("ignores malformed JSON", () => {
    expect(interpretSseEvent({ data: "{not json" })).toEqual({ kind: "ignored" });
  });

  it("ignores an empty delta rather than emitting nothing-text", () => {
    expect(interpretSseEvent({ data: JSON.stringify({ type: "response.output_text.delta", delta: "" }) })).toEqual({
      kind: "ignored",
    });
  });
});

describe("readSseEvent — naming what we don't consume", () => {
  // The whole point: an event the bridge ignores must still be COUNTABLE. The
  // old instrument counted only text deltas, so a turn streaming live tool
  // activity was indistinguishable from a silent one — and got called "buffered".
  it("names an event it does not act on", () => {
    const added = { type: "response.output_item.added", item: { type: "function_call", name: "search_notes" } };
    const { type, signal } = readSseEvent({ data: JSON.stringify(added) });
    expect(type).toBe("response.output_item.added");
    expect(signal).toEqual({ kind: "ignored" }); // behaviour unchanged
  });

  it("agrees with interpretSseEvent on every signal", () => {
    // They must never diverge — the census would then describe a different
    // stream than the one that produced the reply.
    for (const data of [
      JSON.stringify({ type: "response.output_text.delta", delta: "hi" }),
      JSON.stringify({ type: "response.completed", response: { output: [] } }),
      JSON.stringify({ type: "error", error: { message: "nope" } }),
      JSON.stringify({ type: "response.output_item.done" }),
      "[DONE]",
      "{not json",
    ]) {
      expect(readSseEvent({ data }).signal).toEqual(interpretSseEvent({ data }));
    }
  });

  // The run's handle: the one thing on the stream that names the run,
  // and the only way the bridge can later ask whether it parked.
  it("hands back the response id from response.created, in either shape", () => {
    expect(readSseEvent({ data: JSON.stringify({ type: "response.created", response: { id: "run_1" } }) }).signal).toEqual({
      kind: "created",
      id: "run_1",
    });
    expect(readSseEvent({ data: JSON.stringify({ type: "response.created", id: "run_2" }) }).signal).toEqual({
      kind: "created",
      id: "run_2",
    });
    // No id is not a handle. Ignored, never invented.
    expect(readSseEvent({ data: JSON.stringify({ type: "response.created", response: {} }) }).signal).toEqual({ kind: "ignored" });
  });

  it("still names the untypeable, so a broken stream can't look empty", () => {
    expect(readSseEvent({ data: "[DONE]" }).type).toBe("[DONE]");
    expect(readSseEvent({ data: "{not json" }).type).toBe("(unparseable)");
    expect(readSseEvent({ data: "{}" }).type).toBe("(untyped)");
    // An `event:` line names it when the payload doesn't.
    expect(readSseEvent({ event: "response.created", data: "{}" }).type).toBe("response.created");
  });
});

describe("formatCensus", () => {
  it("renders busiest first, ties broken by name", () => {
    const census = new Map([
      ["response.output_text.delta", 2],
      ["response.output_item.added", 7],
      ["response.completed", 1],
    ]);
    expect(formatCensus(census)).toBe("response.output_item.added=7 response.output_text.delta=2 response.completed=1");
  });

  it("is empty for an empty stream rather than throwing", () => {
    expect(formatCensus(new Map())).toBe("");
  });
});
