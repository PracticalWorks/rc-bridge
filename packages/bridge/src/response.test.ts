import { describe, expect, it } from "vitest";
import { describeTools, outputLength, previewArgs, summarizeResponse } from "./response.js";

/** A realistic /v1/responses body, in the shape the gateway actually emits
 * (verified against the gateway this was built on): function_call and
 * function_call_output pairs, then the assistant message. */
const docsTurn = {
  output: [
    {
      type: "function_call",
      name: "search_notes",
      call_id: "call_1",
      arguments: '{\n  "query": "invoices"\n}',
    },
    { type: "function_call_output", call_id: "call_1", output: "x".repeat(4200) },
    {
      type: "function_call",
      name: "search_docs",
      call_id: "call_2",
      arguments: '{"query":"partners"}',
    },
    { type: "function_call_output", call_id: "call_2", output: "" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here's the summary." }] },
  ],
};

describe("summarizeResponse", () => {
  it("still returns the reply text — the behaviour everything else depends on", () => {
    expect(summarizeResponse(docsTurn).text).toBe("Here's the summary.");
  });

  it("carries the response id, model and usage for the ledger, and none when the gateway sent none", () => {
    const out = summarizeResponse({ ...docsTurn, id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } } });
    expect(out).toMatchObject({ id: "resp_1", model: "gpt-5.6-luna", usage: { tokensIn: 50, tokensOut: 5, tokensCached: 20 } });
    const bare = summarizeResponse(docsTurn);
    expect(bare.id).toBeUndefined();
    expect(bare.usage).toBeUndefined();
  });

  it("recovers the tool trace the bridge used to throw away", () => {
    expect(summarizeResponse(docsTurn).tools).toEqual([
      { name: "search_notes", args: '{"query":"invoices"}', outputChars: 4200 },
      { name: "search_docs", args: '{"query":"partners"}', outputChars: 0 },
    ]);
  });

  it("keeps a failed call's error RAW: redaction is the persister's job", () => {
    const out = summarizeResponse({
      output: [
        { type: "function_call", name: "broken", call_id: "bad" },
        { type: "function_call_output", call_id: "bad", is_error: true, output: { detail: "nope" } },
      ],
    });
    expect(out.tools).toEqual([{ name: "broken", error: '{"detail":"nope"}' }]);
  });

  it("matches results to their OWN call, not to whichever came last", () => {
    const out = summarizeResponse({
      output: [
        { type: "function_call", name: "a", call_id: "1" },
        { type: "function_call", name: "b", call_id: "2" },
        { type: "function_call_output", call_id: "2", output: "bb" },
        { type: "function_call_output", call_id: "1", output: "a" },
      ],
    });
    expect(out.tools).toEqual([
      { name: "a", outputChars: 1 },
      { name: "b", outputChars: 2 },
    ]);
  });

  it("records a search that came back EMPTY — the 'did it really find anything' signal", () => {
    const [, docs] = summarizeResponse(docsTurn).tools;
    expect(docs?.outputChars).toBe(0);
  });

  it("keeps the old bare-text behaviour for a turn with no tools", () => {
    const out = summarizeResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    });
    expect(out).toEqual({ text: "hi", tools: [], unknownTypes: [] });
  });

  it("joins multiple message parts, as the old extractor did", () => {
    const out = summarizeResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }],
    });
    expect(out.text).toBe("a\nb");
  });

  it("reports item types it doesn't know instead of silently dropping them", () => {
    // Exactly how the tool calls got lost in the first place.
    const out = summarizeResponse({ output: [{ type: "reasoning" }, { type: "web_search_call" }] });
    expect(out.unknownTypes).toEqual(["reasoning", "web_search_call"]);
  });

  it("keeps a result that has no matching call rather than dropping the evidence", () => {
    const out = summarizeResponse({ output: [{ type: "function_call_output", call_id: "zzz", output: "abc" }] });
    expect(out.tools).toEqual([{ name: "(unmatched result)", outputChars: 3 }]);
  });

  it("survives a malformed body instead of throwing mid-turn", () => {
    for (const junk of [null, undefined, {}, { output: "nope" }, { output: [null, 7] }]) {
      expect(() => summarizeResponse(junk)).not.toThrow();
      expect(summarizeResponse(junk).text).toBe("");
    }
  });

  it("names an unnamed tool rather than recording undefined", () => {
    expect(summarizeResponse({ output: [{ type: "function_call" }] }).tools[0]?.name).toBe("(unnamed tool)");
  });
});

describe("previewArgs", () => {
  it("compacts JSON so model whitespace doesn't eat the preview budget", () => {
    expect(previewArgs('{\n   "q":  "x"\n}')).toBe('{"q":"x"}');
  });

  it("keeps a non-JSON string rather than losing it", () => {
    expect(previewArgs("not json at all")).toBe("not json at all");
  });

  it("truncates a long payload — a file write must not land in the trace whole", () => {
    const preview = previewArgs(JSON.stringify({ content: "y".repeat(5000) }));
    expect(preview!.length).toBeLessThanOrEqual(201);
    expect(preview!.endsWith("…")).toBe(true);
  });

  it("treats empty and absent arguments as nothing to show", () => {
    expect(previewArgs(undefined)).toBeUndefined();
    expect(previewArgs("{}")).toBeUndefined();
    expect(previewArgs("   ")).toBeUndefined();
  });
});

describe("outputLength", () => {
  it("measures the non-streaming shape (a raw string)", () => {
    expect(outputLength("abcd")).toBe(4);
  });

  it("measures the streaming shape (a list of content parts)", () => {
    expect(outputLength([{ type: "input_text", text: "ab" }, { type: "input_text", text: "c" }])).toBe(3);
  });

  it("is undefined when there's nothing measurable", () => {
    expect(outputLength(undefined)).toBeUndefined();
  });
});

describe("describeTools", () => {
  it("says plainly when no tool ran — the answer to 'did it actually look?'", () => {
    expect(describeTools([])).toBe("no tools called");
  });

  it("collapses repeats into a count and totals what came back", () => {
    expect(
      describeTools([
        { name: "search_notes", outputChars: 100 },
        { name: "search_notes", outputChars: 50 },
      ]),
    ).toBe("search_notes×2 (150 chars back)");
  });
});
