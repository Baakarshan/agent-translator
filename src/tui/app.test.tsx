import { describe, expect, test } from "vitest";

import type { DisplayMessage } from "../types.js";
import type { SessionDescriptor } from "../types.js";
import {
  flattenTranscript,
  getDescriptorWatchKey,
  getTranscriptRenderKey,
  resolveSelectedDescriptor,
} from "./app.js";

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

    expect(lines.some((line) => line.prefix?.includes("翻译"))).toBe(true);
    expect(lines.some((line) => line.text.includes("缓存文本"))).toBe(true);
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

    expect(lines.some((line) => line.prefix?.includes("命令"))).toBe(true);
    expect(lines.some((line) => line.text.includes("这个命令会查看当前工作区改动。"))).toBe(true);
    expect(lines.some((line) => line.text.includes("git diff"))).toBe(false);
  });

  test("keeps continuation lines aligned after the label column", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          displayText: "第一行\n第二行",
          translationStatus: "cached",
        }),
      ],
      80,
    );

    expect(lines[0]?.prefix).toBe("翻译 ");
    expect(lines[1]?.prefix).toBe("     ");
    expect(lines[1]?.text).toBe("第二行");
  });

  test("renders translated markdown tables as box tables instead of raw pipes", () => {
    const lines = flattenTranscript(
      [
        createAssistantMessage({
          kind: "table",
          displayMode: "translate",
          displayText: [
            "| 功能 | 含义 |",
            "| --- | --- |",
            "| 实时输入 | 即时翻译 |",
            "| 提供方切换 | 切换模型 |",
          ].join("\n"),
          translationStatus: "translated",
        }),
      ],
      80,
    );

    expect(lines.some((line) => line.text.includes("┌"))).toBe(true);
    expect(lines.some((line) => line.text.includes("│ 功能"))).toBe(true);
    expect(lines.some((line) => line.text.includes("| --- |"))).toBe(false);
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

describe("getDescriptorWatchKey", () => {
  test("stays stable when mutable descriptor fields change", () => {
    const base: SessionDescriptor = {
      provider: "codex",
      sessionId: "session-1",
      filePath: "/tmp/session.jsonl",
      cwd: "/tmp/project",
      title: "old title",
      lastActivityAt: "2026-04-22T00:00:00.000Z",
      lastActivityMs: 1,
      live: false,
    };

    const next: SessionDescriptor = {
      ...base,
      title: "new title",
      lastActivityAt: "2026-04-22T00:01:00.000Z",
      lastActivityMs: 2,
      live: true,
    };

    expect(getDescriptorWatchKey(base)).toBe(getDescriptorWatchKey(next));
  });
});

describe("resolveSelectedDescriptor", () => {
  test("keeps the attached session even when a newer latest session appears", () => {
    const sessions: SessionDescriptor[] = [
      {
        provider: "codex",
        sessionId: "current-session",
        filePath: "/tmp/current.jsonl",
        cwd: "/tmp/project",
        title: "current",
        lastActivityAt: "2026-04-22T00:00:00.000Z",
        lastActivityMs: 1,
        live: true,
      },
      {
        provider: "codex",
        sessionId: "newer-session",
        filePath: "/tmp/newer.jsonl",
        cwd: "/tmp/project",
        title: "newer",
        lastActivityAt: "2026-04-22T00:01:00.000Z",
        lastActivityMs: 2,
        live: true,
      },
    ];

    const descriptor = resolveSelectedDescriptor({
      sessions,
      provider: "codex",
      latest: true,
      sessionId: "current-session",
      cwd: "/tmp/project",
      selectedIndex: 0,
    });

    expect(descriptor?.sessionId).toBe("current-session");
  });

  test("uses latest matching session before anything is attached", () => {
    const sessions: SessionDescriptor[] = [
      {
        provider: "codex",
        sessionId: "older-session",
        filePath: "/tmp/older.jsonl",
        cwd: "/tmp/project",
        title: "older",
        lastActivityAt: "2026-04-22T00:00:00.000Z",
        lastActivityMs: 1,
        live: true,
      },
      {
        provider: "codex",
        sessionId: "newest-session",
        filePath: "/tmp/newest.jsonl",
        cwd: "/tmp/project",
        title: "newest",
        lastActivityAt: "2026-04-22T00:02:00.000Z",
        lastActivityMs: 3,
        live: true,
      },
    ];

    const descriptor = resolveSelectedDescriptor({
      sessions,
      provider: "codex",
      latest: true,
      sessionId: null,
      cwd: "/tmp/project",
      selectedIndex: 0,
    });

    expect(descriptor?.sessionId).toBe("newest-session");
  });
});

describe("getTranscriptRenderKey", () => {
  test("stays stable when transcript rendering is unchanged", () => {
    const message = createAssistantMessage({
      displayText: "缓存文本",
      translationStatus: "cached",
    });

    expect(getTranscriptRenderKey([message], 80)).toBe(getTranscriptRenderKey([message], 80));
  });

  test("changes when rendered transcript output changes", () => {
    const before = createAssistantMessage({
      displayText: "第一版",
      translationStatus: "cached",
    });
    const after = createAssistantMessage({
      displayText: "第二版",
      translationStatus: "cached",
    });

    expect(getTranscriptRenderKey([before], 80)).not.toBe(getTranscriptRenderKey([after], 80));
  });
});
