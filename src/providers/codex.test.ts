import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { parseCodexSessionFile } from "./codex.js";

const fixturePath = path.join(process.cwd(), "src", "tests", "fixtures", "codex-rollout.jsonl");

describe("parseCodexSessionFile", () => {
  test("normalizes codex transcript messages and dedupes mirrored records", async () => {
    const snapshot = await parseCodexSessionFile(fixturePath);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.provider).toBe("codex");
    expect(snapshot?.sessionId).toBe("019d958f-1fb2-75d0-8181-7339ec961519");
    expect(snapshot?.cwd).toBe("/Users/baakarshan/Developer/products/demo");
    expect(snapshot?.messages.map((message) => [message.role, message.kind, message.originalText])).toEqual([
      ["user", "prose", "Please help me review this change"],
      ["assistant", "prose", "I will inspect the diff first."],
    ]);
  });

  test("ignores a partial trailing line until it is completed", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-codex-"));
    const filePath = path.join(temporaryDir, "rollout-test.jsonl");
    const completePrefix = await readFile(fixturePath, "utf8");
    const partialLine =
      '{"timestamp":"2026-04-16T09:13:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Trailing';

    await writeFile(filePath, `${completePrefix}\n${partialLine}`, "utf8");
    const incomplete = await parseCodexSessionFile(filePath);
    expect(incomplete?.messages.at(-1)?.originalText).toBe("I will inspect the diff first.");

    await writeFile(
      filePath,
      `${completePrefix}\n${partialLine} assistant message"}]}}\n`,
      "utf8",
    );
    const complete = await parseCodexSessionFile(filePath);
    expect(complete?.messages.at(-1)?.originalText).toBe("I will inspect the diff first.\n\nTrailing assistant message");
  });
});
