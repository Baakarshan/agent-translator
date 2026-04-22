import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { ParsedMessage, TranslatorConfig } from "../types.js";
import { TranslationCache } from "./cache.js";
import { TranscriptTranslationStore } from "./service.js";

const baseConfig: TranslatorConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.com",
  model: "gpt-5.2",
  promptVersion: "v1",
  debounceMs: 0,
};

function createMessage(id: string, text: string): ParsedMessage {
  return {
    provider: "codex",
    sessionId: "session-1",
    messageId: id,
    role: "assistant",
    originalText: text,
    timestamp: "2026-04-22T00:00:00.000Z",
  };
}

describe("TranscriptTranslationStore", () => {
  async function waitForCondition(
    predicate: () => boolean,
    timeoutMs = 500,
    intervalMs = 10,
  ): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for condition");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  test("reuses cached translations and avoids duplicate network work", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const translate = vi.fn().mockResolvedValue("第一次翻译");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { translate } as any,
    });

    await store.setMessages([createMessage("msg-1", "Hello world")]);
    await waitForCondition(() => store.getMessages()[0]?.translationStatus === "translated");
    expect(store.getMessages()[0]?.translatedText).toBe("第一次翻译");
    expect(translate).toHaveBeenCalledTimes(1);

    await store.setMessages([createMessage("msg-1", "Hello world")]);
    expect(store.getMessages()[0]?.translatedText).toBe("第一次翻译");
    expect(translate).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  test("marks only the failing row as failed", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("第二条成功");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { translate } as any,
    });

    await store.setMessages([
      createMessage("msg-1", "First"),
      createMessage("msg-2", "Second"),
    ]);
    await waitForCondition(() => {
      const messages = store.getMessages();
      return messages[0]?.translationStatus === "failed" && messages[1]?.translationStatus === "translated";
    });

    const messages = store.getMessages();
    expect(messages[0]?.translationStatus).toBe("failed");
    expect(messages[1]?.translationStatus).toBe("translated");
    expect(messages[1]?.translatedText).toBe("第二条成功");
    store.destroy();
  });
});
