import { describe, expect, it } from "vitest";
import { AgentHttpError, AgentRunFailedError } from "./agent.js";
import { createAgentOutages, describeAgentFailure, outageReply } from "./outage.js";

describe("createAgentOutages: once per room per outage, kept per profile", () => {
  it("tells a room once, then stays quiet there until the profile recovers", () => {
    const outages = createAgentOutages();
    expect(outages.failed("factory", "R1")).toBe(true);
    expect(outages.failed("factory", "R1")).toBe(false);
    outages.recovered("factory");
    expect(outages.failed("factory", "R1")).toBe(true);
  });

  it("a success on another profile does not end this profile's outage", () => {
    // The Nov 24 shape: house answers while factory keeps failing. One shared
    // counter reset on house's success and factory warned again every time.
    const outages = createAgentOutages();
    expect(outages.failed("factory", "DM-hermes")).toBe(true);
    outages.recovered("house");
    expect(outages.failed("factory", "DM-hermes")).toBe(false);
  });

  it("a room that was never told still hears it while another room was told first", () => {
    const outages = createAgentOutages();
    expect(outages.failed("factory", "R1")).toBe(true);
    expect(outages.failed("factory", "R2")).toBe(true);
    expect(outages.failed("factory", "R2")).toBe(false);
  });

  it("two profiles failing in one room are two outages", () => {
    const outages = createAgentOutages();
    expect(outages.failed("factory", "R1")).toBe(true);
    expect(outages.failed("house", "R1")).toBe(true);
  });

  it("forgets the oldest room past its bound rather than growing forever", () => {
    const outages = createAgentOutages();
    for (let i = 0; i < 501; i++) outages.failed("factory", `R${i}`);
    expect(outages.toldCount("factory")).toBe(500);
    expect(outages.failed("factory", "R0")).toBe(true);
    expect(outages.failed("factory", "R500")).toBe(false);
  });
});

describe("describeAgentFailure names the kind of failure, never the server's text", () => {
  it("rate limit, refused key and other statuses", () => {
    expect(describeAgentFailure(new AgentHttpError(429, "returned 429: secret body"))).toBe(
      "The agent is rate limited right now (HTTP 429)",
    );
    expect(describeAgentFailure(new AgentHttpError(401, "x"))).toBe("The agent refused the bridge's key (HTTP 401)");
    expect(describeAgentFailure(new AgentHttpError(403, "x"))).toBe("The agent refused the bridge's key (HTTP 403)");
    expect(describeAgentFailure(new AgentHttpError(502, "x"))).toBe("The agent answered with an error (HTTP 502)");
  });

  it("a failed run, and a transport error", () => {
    expect(describeAgentFailure(new AgentRunFailedError("Agent stream failed: anything"))).toBe(
      "The agent started this turn, but the run failed",
    );
    expect(describeAgentFailure(new TypeError("fetch failed"))).toBe("Can't reach the agent right now");
  });

  it("the posted reply carries none of the error body", () => {
    const reply = outageReply(new AgentHttpError(429, "Agent /v1/responses returned 429: token sk-should-not-leak"));
    expect(reply).toBe("⚠️ The agent is rate limited right now (HTTP 429). I'll stay quiet in this room until it's back.");
    expect(reply).not.toContain("sk-");
  });
});
