import { describe, expect, test } from "vitest";

import { splitAssistantMessage } from "./common.js";

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
});
