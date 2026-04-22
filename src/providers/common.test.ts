import { describe, expect, test } from "vitest";

import { finalizeMessages, splitAssistantMessage } from "./common.js";

describe("splitAssistantMessage", () => {
  test("classifies prose, code, command, diff, shell, and table blocks", () => {
    const segments = splitAssistantMessage({
      role: "assistant",
      text: [
        "Here is the overview.",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "$ npm run build",
        "",
        "```diff",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@",
        "+const next = true;",
        "```",
        "",
        "Error: boom",
        "    at main (src/app.ts:1:1)",
        "",
        "| Name | Status |",
        "| --- | --- |",
        "| api | ok |",
      ].join("\n"),
      timestamp: "2026-04-22T00:00:00.000Z",
    });

    expect(segments.map((segment) => segment.kind)).toEqual([
      "prose",
      "code",
      "command",
      "diff",
      "shell",
      "table",
    ]);
  });

  test("drops explicit reasoning blocks", () => {
    const segments = splitAssistantMessage({
      role: "assistant",
      text: "```thinking\nprivate chain of thought\n```",
      timestamp: "2026-04-22T00:00:00.000Z",
    });

    expect(segments).toEqual([]);
  });

  test("merges adjacent assistant prose blocks into one transcript item", () => {
    const messages = finalizeMessages("codex", "session-1", [
      {
        role: "assistant",
        text: "First update.",
        timestamp: "2026-04-22T00:00:00.000Z",
      },
      {
        role: "assistant",
        text: "Second update.",
        timestamp: "2026-04-22T00:00:01.000Z",
      },
      {
        role: "assistant",
        text: "```bash\nnpm run verify\n```",
        timestamp: "2026-04-22T00:00:02.000Z",
      },
      {
        role: "assistant",
        text: "Third update.",
        timestamp: "2026-04-22T00:00:03.000Z",
      },
    ]);

    expect(messages.map((message) => [message.kind, message.originalText])).toEqual([
      ["prose", "First update.\n\nSecond update."],
      ["command", "```bash\nnpm run verify\n```"],
      ["prose", "Third update."],
    ]);
  });

  test("merges adjacent assistant command activity into one transcript item", () => {
    const messages = finalizeMessages("codex", "session-1", [
      {
        role: "assistant",
        text: "npm run test",
        kind: "command",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:00.000Z",
      },
      {
        role: "assistant",
        text: "npm run build",
        kind: "command",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:01.000Z",
      },
      {
        role: "assistant",
        text: "apply_patch",
        kind: "tool",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:02.000Z",
      },
      {
        role: "assistant",
        text: "write_stdin",
        kind: "tool",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:03.000Z",
      },
    ]);

    expect(messages.map((message) => [message.kind, message.originalText])).toEqual([
      ["command", "npm run test\u0001npm run build"],
      ["tool", "apply_patch\nwrite_stdin"],
    ]);
  });

  test("keeps a multiline command as one command entry when merging", () => {
    const messages = finalizeMessages("codex", "session-1", [
      {
        role: "assistant",
        text: "node --input-type=module <<'EOF'\nconsole.log('hi')\nEOF",
        kind: "command",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:00.000Z",
      },
      {
        role: "assistant",
        text: "git status",
        kind: "command",
        displayMode: "summarize",
        timestamp: "2026-04-22T00:00:01.000Z",
      },
    ]);

    expect(messages.map((message) => [message.kind, message.originalText])).toEqual([
      ["command", "node --input-type=module <<'EOF'\nconsole.log('hi')\nEOF\u0001git status"],
    ]);
  });
});
