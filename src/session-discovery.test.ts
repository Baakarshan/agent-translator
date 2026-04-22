import { mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SessionDescriptor } from "./types.js";

describe("session discovery", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("sorts discovered sessions by latest activity", async () => {
    const homeDir = path.join(os.tmpdir(), `agent-translator-home-${Date.now()}`);
    await mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);

    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "22");
    const claudeDir = path.join(homeDir, ".claude", "projects", "demo-project");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });

    const codexFile = path.join(codexDir, "rollout-a.jsonl");
    const claudeFile = path.join(claudeDir, "session-b.jsonl");

    await writeFile(
      codexFile,
      '{"type":"session_meta","payload":{"id":"codex-1","cwd":"/tmp/codex"}}\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"older"}]}}\n',
      "utf8",
    );
    await writeFile(
      claudeFile,
      '{"type":"user","message":{"role":"user","content":"newer"},"sessionId":"claude-1","cwd":"/tmp/claude","timestamp":"2026-04-22T00:00:00.000Z"}\n',
      "utf8",
    );

    const older = new Date("2026-04-22T00:00:00.000Z");
    const newer = new Date("2026-04-22T00:01:00.000Z");
    await utimes(codexFile, older, older);
    await utimes(claudeFile, newer, newer);

    const module = await import("./session-discovery.js");
    const sessions = await module.discoverSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(["claude-1", "codex-1"]);
  });

  test("selects latest or explicit session without extra heuristics", async () => {
    const sessions: SessionDescriptor[] = [
      {
        provider: "claude",
        sessionId: "claude-1",
        filePath: "/tmp/a",
        cwd: "/tmp/a",
        title: "claude",
        lastActivityAt: "2026-04-22T00:01:00.000Z",
        lastActivityMs: 2,
        live: true,
      },
      {
        provider: "codex",
        sessionId: "codex-1",
        filePath: "/tmp/b",
        cwd: "/tmp/b",
        title: "codex",
        lastActivityAt: "2026-04-22T00:00:00.000Z",
        lastActivityMs: 1,
        live: true,
      },
    ];

    const { selectSessionDescriptor } = await import("./session-discovery.js");
    expect(selectSessionDescriptor(sessions, { latest: true })?.sessionId).toBe("claude-1");
    expect(
      selectSessionDescriptor(sessions, { provider: "codex", latest: true })?.sessionId,
    ).toBe("codex-1");
    expect(selectSessionDescriptor(sessions, { sessionId: "claude-1" })?.provider).toBe("claude");
  });
});
