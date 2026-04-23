import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { parseClaudeSessionFile } from "./claude.js";

const fixturePath = path.join(process.cwd(), "src", "tests", "fixtures", "claude-session.jsonl");

describe("parseClaudeSessionFile", () => {
  test("normalizes claude transcript messages and skips hidden thinking-only rows", async () => {
    const snapshot = await parseClaudeSessionFile(fixturePath);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.provider).toBe("claude");
    expect(snapshot?.sessionId).toBe("7f05debe-9613-4a45-9ec2-0a0326076059");
    expect(snapshot?.messages.map((message) => [message.role, message.originalText])).toEqual([
      ["user", "Please summarize the current API changes."],
      ["assistant", "Here is a concise API summary."],
      ["assistant", "/Users/baakarshan/Developer/products/demo\u0000/exit"],
      ["assistant", "Goodbye!"],
    ]);
  });

  test("captures claude tool use, slash commands, and local command output without leaking control rows", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-claude-"));
    const sessionPath = path.join(temporaryDir, "claude-tool-session.jsonl");
    await writeFile(sessionPath, [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Inspect README.md and then stop." },
        timestamp: "2026-04-22T00:00:00.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/workspace/README.md" } }],
        },
        timestamp: "2026-04-22T00:00:01.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: true, content: "Error: File does not exist." }],
        },
        timestamp: "2026-04-22T00:00:02.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
        },
        timestamp: "2026-04-22T00:00:03.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to \u001b[1mSonnet 4.6 (default)\u001b[22m</local-command-stdout>",
        },
        timestamp: "2026-04-22T00:00:04.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "\u0003" },
        timestamp: "2026-04-22T00:00:05.000Z",
        cwd: "/Users/baakarshan/Developer/products/agent-translator",
        sessionId: "claude-tool-session",
      }),
      "",
    ].join("\n"));

    const snapshot = await parseClaudeSessionFile(sessionPath);

    expect(snapshot?.messages.map((message) => ({
      role: message.role,
      kind: message.kind,
      text: message.originalText,
    }))).toEqual([
      { role: "user", kind: "prose", text: "Inspect README.md and then stop." },
      {
        role: "assistant",
        kind: "tool",
        text: "Read\u0000/Users/baakarshan/Developer/products/agent-translator/README.md",
      },
      { role: "assistant", kind: "shell", text: "Error: File does not exist." },
      {
        role: "assistant",
        kind: "command",
        text: "/Users/baakarshan/Developer/products/agent-translator\u0000/model",
      },
      { role: "assistant", kind: "shell", text: "Set model to Sonnet 4.6 (default)" },
    ]);
  });
});
