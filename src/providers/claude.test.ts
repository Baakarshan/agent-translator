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
    ]);
  });
});

