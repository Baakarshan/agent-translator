import { describe, expect, test } from "vitest";

import type { DisplayMessage } from "../types.js";
import { flattenTranscript } from "./app.js";

function createAssistantMessage(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    provider: "codex",
    sessionId: "session-1",
    messageId: "msg-1",
    role: "assistant",
    kind: "prose",
    displayMode: "translate",
    originalText: "Hello world",
    summaryText: null,
    displayText: null,
    translationStatus: "idle",
    timestamp: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("flattenTranscript", () => {
  test("shows cached Chinese translations without the original English text", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          displayText: "缓存文本",
          translationStatus: "cached",
        }),
      ],
      80,
    );

    expect(lines.some((line) => line.text.includes("译 [缓存] 缓存文本"))).toBe(true);
    expect(lines.some((line) => line.text.includes("Hello world"))).toBe(false);
  });

  test("shows summary-only rows for technical blocks", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          kind: "command",
          displayMode: "summarize",
          originalText: "git diff",
          displayText: "这个命令会查看当前工作区改动。",
          translationStatus: "translated",
        }),
      ],
      120,
    );

    expect(lines.some((line) => line.text.includes("摘要 这个命令会查看当前工作区改动。"))).toBe(true);
    expect(lines.some((line) => line.text.includes("git diff"))).toBe(false);
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

    expect(lines.some((line) => line.text.includes("状态 [失败:"))).toBe(true);
    expect(lines.some((line) => line.text.includes("upstream timeout"))).toBe(true);
  });
});
