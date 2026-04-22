import { describe, expect, test } from "vitest";

import type { SessionSnapshot } from "./types.js";
import { getSnapshotContentKey } from "./session-watch.js";

function createSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    provider: "codex",
    sessionId: "session-1",
    filePath: "/tmp/session.jsonl",
    cwd: "/tmp/project",
    title: "demo",
    lastActivityAt: "2026-04-22T00:00:00.000Z",
    lastActivityMs: 1,
    live: true,
    messages: [
      {
        provider: "codex",
        sessionId: "session-1",
        messageId: "msg-1",
        role: "assistant",
        kind: "prose",
        displayMode: "translate",
        originalText: "Hello world",
        summaryText: null,
        displayText: null,
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("getSnapshotContentKey", () => {
  test("stays stable when only activity metadata changes", () => {
    const base = createSnapshot();
    const next = createSnapshot({
      lastActivityAt: "2026-04-22T00:01:00.000Z",
      lastActivityMs: 2,
      live: false,
      title: "updated title",
    });

    expect(getSnapshotContentKey(base)).toBe(getSnapshotContentKey(next));
  });

  test("changes when transcript content changes", () => {
    const base = createSnapshot();
    const next = createSnapshot({
      messages: [
        ...base.messages,
        {
          ...base.messages[0]!,
          messageId: "msg-2",
          originalText: "Another message",
          timestamp: "2026-04-22T00:00:01.000Z",
        },
      ],
    });

    expect(getSnapshotContentKey(base)).not.toBe(getSnapshotContentKey(next));
  });
});
