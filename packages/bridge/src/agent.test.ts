import { describe, expect, it } from "vitest";
import { DeadlineError, fetchWithTimeout } from "@practicalworks/rc-client";
import { AgentHttpError, AgentRunFailedError, createAgentClient, isTurnTimeout, type AgentTarget } from "./agent.js";

const target: AgentTarget = { url: "http://agent.test/", apiKey: "k", model: "test-model" };

/** A fetch that answers each call from `replies` in order and records the calls. */
function fakeFetch(replies: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: typeof fetch) {
  return createAgentClient({ timeoutMs: 5_000, parkCheckMs: 50, streaming: true, log: () => {}, fetchImpl });
}

describe("readRun maps GET /v1/runs/{id} for the park check", () => {
  it("parked: waiting_for_approval, confirmed by a second read", async () => {
    const f = fakeFetch([json({ status: "waiting_for_approval", created_at: "t0", last_event: "approval.request" })]);
    const run = await client(f.impl).readRun(target, "run/1");
    expect(run).toEqual({
      ok: true,
      done: false,
      status: "waiting_for_approval",
      runId: "run/1",
      parked: true,
      createdAt: "t0",
      lastEvent: "approval.request",
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe("http://agent.test/v1/runs/run%2F1");
    expect(f.calls[0]!.init.method).toBe("GET");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("running: not terminal, not parked — and no parked key at all", async () => {
    const f = fakeFetch([json({ status: "running" })]);
    const run = await client(f.impl).readRun(target, "r");
    expect(run).toEqual({ ok: true, done: false, status: "running", runId: "r" });
    expect(f.calls).toHaveLength(1);
  });

  it("a park the confirming read has already cleared is running", async () => {
    const f = fakeFetch([json({ status: "waiting_for_approval" }), json({ status: "running" })]);
    const run = await client(f.impl).readRun(target, "r");
    expect(run).toMatchObject({ ok: true, done: false, status: "running" });
    expect(run).not.toHaveProperty("parked");
  });

  it("done: every terminal state, case- and space-insensitive", async () => {
    for (const status of ["completed", "failed", "cancelled", "canceled", "  Completed "]) {
      const run = await client(fakeFetch([json({ status })]).impl).readRun(target, "r");
      expect(run, status).toMatchObject({ ok: true, done: true });
      expect(run, status).not.toHaveProperty("parked");
    }
  });

  it("error: a 404 is an expired run, any other failure is ok:false", async () => {
    const expired = await client(fakeFetch([json({}, 404)]).impl).readRun(target, "r");
    expect(expired).toMatchObject({ ok: false, expired: true });

    const broken = await client(fakeFetch([json({ error: "boom" }, 500)]).impl).readRun(target, "r");
    expect(broken).toMatchObject({ ok: false });
    expect(broken).not.toHaveProperty("expired");

    const unreachable = await client((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch).readRun(target, "r");
    expect(unreachable).toMatchObject({ ok: false });
  });
});

describe("one request builder for both turns", () => {
  it("names a rejected image on the streamed path too", async () => {
    const f = fakeFetch([() => new Response("no images", { status: 400 })]);
    const img = [{ name: "a.png", dataUrl: "data:image/png;base64,AA==" }];
    await expect(
      client(f.impl).askStreaming(target, "c", "p", img),
    ).rejects.toThrow(/rejected the image \(400\)/);
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "input", "store", "conversation", "stream"]);
  });

  it("the plain turn sends no stream flag and reports only a total", async () => {
    const f = fakeFetch([json({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })]);
    const turn = await client(f.impl).ask(target, "c", "p");
    expect(turn.text).toBe("hi");
    expect(turn.timings).toMatchObject({ firstEventMs: null, firstTextMs: null });
    expect(typeof turn.timings.totalMs).toBe("number");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "input", "store", "conversation"]);
  });

  it("a streamed turn returns when its first event and first text arrived", async () => {
    const sse = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "he" },
      { type: "response.output_text.delta", delta: "llo" },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const f = fakeFetch([() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const turn = await client(f.impl).askStreaming(target, "c", "p", []);
    expect(turn.text).toBe("hello");
    expect(turn.timings.firstEventMs).toEqual(expect.any(Number));
    expect(turn.timings.firstTextMs).toEqual(expect.any(Number));
    expect(turn.timings.totalMs).toBeGreaterThanOrEqual(turn.timings.firstTextMs!);
  });
});

describe("a failed turn is typed by what failed", () => {
  it("a non-2xx answer carries its status, plain or streamed", async () => {
    const f = fakeFetch([() => new Response("usage limit reached", { status: 429 })]);
    const plain = await client(f.impl).ask(target, "c", "p").catch((e: unknown) => e);
    const streamed = await client(f.impl).askStreaming(target, "c", "p", []).catch((e: unknown) => e);
    for (const err of [plain, streamed]) {
      expect(err).toBeInstanceOf(AgentHttpError);
      expect((err as AgentHttpError).status).toBe(429);
      expect((err as Error).message).toMatch(/returned 429: usage limit reached/);
    }
  });

  it("a rejected image is an HTTP 400 too", async () => {
    const f = fakeFetch([() => new Response("no images", { status: 400 })]);
    const img = [{ name: "a.png", dataUrl: "data:image/png;base64,AA==" }];
    const err = await client(f.impl).ask(target, "c", "p", img).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentHttpError);
    expect((err as AgentHttpError).status).toBe(400);
  });

  it("a run the stream reports failed is a run failure, not an HTTP error", async () => {
    const sse = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.failed", error: { message: "provider exhausted" } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const f = fakeFetch([() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const err = await client(f.impl).askStreaming(target, "c", "p", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err).not.toBeInstanceOf(AgentHttpError);
    expect((err as Error).message).toBe("Agent stream failed: provider exhausted");
  });
});

describe("a turn past its deadline is typed, plain or streamed", () => {
  /** A gateway that never sends headers: only the abort ends the call. */
  const silent = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const slowClient = () =>
    createAgentClient({ timeoutMs: 20, parkCheckMs: 50, streaming: true, log: () => {}, fetchImpl: silent });

  it("classifies both request shapes as a turn timeout", async () => {
    const plain = await slowClient().ask(target, "c", "hi").catch((e: unknown) => e);
    const streamed = await slowClient().askStreaming(target, "c", "hi", []).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(DeadlineError);
    expect(isTurnTimeout(plain)).toBe(true);
    // The streamed label is the one the old message regex could not see.
    expect((streamed as Error).message).toBe("Agent /v1/responses (stream) timed out after 0s");
    expect(isTurnTimeout(streamed)).toBe(true);
  });

  it("does not call another request's deadline, or a transport error, a turn timeout", async () => {
    const rc = await fetchWithTimeout("http://rc.test", {}, "Rocket.Chat chat.postMessage", 20, silent).catch((e: unknown) => e);
    expect(rc).toBeInstanceOf(DeadlineError);
    expect(isTurnTimeout(rc)).toBe(false);
    expect(isTurnTimeout(new Error("Agent /v1/responses timed out after 6s"))).toBe(false);
  });
});
