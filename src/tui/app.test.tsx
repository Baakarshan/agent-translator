import { describe, expect, test } from "vitest";

import type { DisplayMessage } from "../types.js";
import { flattenTranscript } from "./app.js";

function createAssistantMessage(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    provider: "codex",
    sessionId: "session-1",
    messageId: "msg-1",
    role: "assistant",
    originalText: "Hello world",
    translatedText: null,
    translationStatus: "idle",
    timestamp: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("flattenTranscript", () => {
  test("shows cached translations with a distinct marker", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          translatedText: "缓存文本",
          translationStatus: "cached",
        }),
      ],
      80,
    );

    expect(lines.some((line) => line.text.includes("ZH = 缓存文本"))).toBe(true);
  });

  test("shortens translation failures for display", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          translationStatus: "failed",
          translationError: "Translation request failed: 500 upstream timeout while waiting for provider response",
        }),
      ],
      120,
    );

    expect(lines.some((line) => line.text.includes("ZH ! [failed:"))).toBe(true);
    expect(lines.some((line) => line.text.includes("upstream timeout"))).toBe(true);
  });
});
