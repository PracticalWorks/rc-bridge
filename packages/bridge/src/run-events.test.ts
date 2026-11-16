import { describe, expect, it } from "vitest";
import { approvalDetailsFromEvent } from "./run-events.js";

describe("approval run events", () => {
  it("reads the gated command and choices from an approval event", () => {
    expect(
      approvalDetailsFromEvent({
        type: "approval.request",
        command: "rm -rf ./build",
        choices: ["once", "session", "deny"],
      }),
    ).toEqual({ command: "rm -rf ./build", choices: ["once", "session", "deny"] });
  });

  it("accepts gateway payloads nested under data", () => {
    expect(approvalDetailsFromEvent({ data: { command_text: "deploy", options: ["once", "deny"] } })).toEqual({
      command: "deploy",
      choices: ["once", "deny"],
    });
  });

  it("ignores unrelated events", () => {
    expect(approvalDetailsFromEvent({ type: "response.output_text.delta", delta: "hello" })).toBeUndefined();
  });
});
