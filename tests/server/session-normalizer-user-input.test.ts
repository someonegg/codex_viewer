import { describe, expect, it } from "vitest";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

const QUESTIONS = {
  questions: [{
    header: "Choice",
    id: "choice",
    question: "Which option should be used?",
    options: [
      { label: "First", description: "Use the first approach." },
      { label: "Second", description: "Use the second approach." },
    ],
  }],
};

describe("request_user_input normalization", () => {
  it("emits append-stable request and answered response records instead of tools", () => {
    const request = userInputRequest(1, "answered", QUESTIONS);
    const before = normalizeRecords("user-input-before", [request]);
    const after = normalizeRecords("user-input-after", [
      request,
      userInputOutput(2, "answered", JSON.stringify({
        answers: { choice: { answers: ["Second"] } },
      })),
    ]);

    expect(after.timeline).toEqual([
      {
        kind: "user_input",
        stage: "request",
        id: "user-input-1",
        ordinal: 1,
        timestamp: null,
        callId: "answered",
        questions: QUESTIONS.questions,
      },
      {
        kind: "user_input",
        stage: "response",
        id: "user-input-2",
        ordinal: 2,
        timestamp: null,
        callId: "answered",
        outcome: "answered",
        answers: [{ questionId: "choice", answers: ["Second"] }],
      },
    ]);
    expect(after.timeline[0]).toEqual(before.timeline[0]);
    expect(after.session).toMatchObject({ messageCount: 0, toolCount: 0, itemCount: 2 });
    expect(after.toolDetails.size).toBe(0);
  });

  it("recognizes the Codex aborted output while retaining the request", () => {
    const normalized = normalizeRecords("user-input-aborted", [
      userInputRequest(1, "aborted", QUESTIONS),
      userInputOutput(2, "aborted", "aborted by user after 344.5s"),
    ]);

    expect(normalized.timeline[1]).toMatchObject({
      kind: "user_input",
      stage: "response",
      callId: "aborted",
      outcome: "aborted",
    });
  });

  it("retains malformed recognized records safely and reports diagnostics", () => {
    const normalized = normalizeRecords("user-input-invalid", [
      userInputRequest(1, "invalid", { questions: [] }),
      userInputOutput(2, "invalid", "unexpected response"),
    ]);

    expect(normalized.timeline[0]).toMatchObject({
      kind: "user_input",
      stage: "request",
      questions: [],
    });
    expect(normalized.timeline[1]).toMatchObject({
      kind: "user_input",
      stage: "response",
      outcome: "unavailable",
      summary: "unexpected response",
    });
    expect(normalized.session.diagnostics.map(({ code, ordinal }) => [code, ordinal]))
      .toEqual([
        ["invalid_user_input", 1],
        ["invalid_user_input", 2],
      ]);
  });

  it("limits unavailable response summaries to 256 code units", () => {
    const response = `${"x".repeat(255)}😀`;
    const normalized = normalizeRecords("user-input-summary-limit", [
      userInputRequest(1, "invalid", { questions: [] }),
      userInputOutput(2, "invalid", response),
    ]);
    const item = normalized.timeline[1];

    expect(item.kind === "user_input" && item.stage === "response" &&
        item.outcome === "unavailable" ? item.summary : null).toHaveLength(255);
  });

  it("keeps an output without a preceding request_user_input call as a tool output", () => {
    const normalized = normalizeRecords("unmatched-user-input", [
      userInputOutput(1, "missing", "result"),
    ]);

    expect(normalized.timeline[0]).toMatchObject({
      kind: "tool",
      stage: "output",
      callId: "missing",
      toolName: "unknown tool",
    });
  });

  it("consumes a request after its first response", () => {
    const normalized = normalizeRecords("duplicate-user-input-output", [
      userInputRequest(1, "duplicate", QUESTIONS),
      userInputOutput(2, "duplicate", JSON.stringify({
        answers: { choice: { answers: ["First"] } },
      })),
      userInputOutput(3, "duplicate", JSON.stringify({
        answers: { choice: { answers: ["Second"] } },
      })),
    ]);

    expect(normalized.timeline[1]).toMatchObject({
      kind: "user_input",
      stage: "response",
      outcome: "answered",
    });
    expect(normalized.timeline[2]).toMatchObject({
      kind: "tool",
      stage: "output",
      toolName: "unknown tool",
    });
  });
});

function userInputRequest(ordinal: number, callId: string, argumentsValue: unknown) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: callId,
        arguments: JSON.stringify(argumentsValue),
      },
    },
  };
}

function userInputOutput(ordinal: number, callId: string, output: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output },
    },
  };
}
