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
    kind: "prose",
    displayMode: "translate",
    originalText: text,
    summaryText: null,
    displayText: null,
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
    const generate = vi.fn().mockResolvedValue("第一次翻译");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([createMessage("msg-1", "Hello world")]);
    await waitForCondition(() => store.getMessages()[0]?.translationStatus === "translated");
    expect(store.getMessages()[0]?.displayText).toBe("第一次翻译");
    expect(generate).toHaveBeenCalledTimes(1);

    await store.setMessages([createMessage("msg-1", "Hello world")]);
    expect(store.getMessages()[0]?.displayText).toBe("第一次翻译");
    expect(generate).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  test("marks reused text from the cache as cached for a new row", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn().mockResolvedValue("缓存命中");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([createMessage("msg-1", "Cache me")]);
    await waitForCondition(() => store.getMessages()[0]?.translationStatus === "translated");

    await store.setMessages([createMessage("msg-2", "Cache me")]);
    const nextMessage = store.getMessages()[0];
    expect(nextMessage?.displayText).toBe("缓存命中");
    expect(nextMessage?.translationStatus).toBe("cached");
    expect(generate).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  test("marks only the failing row as failed", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("第二条成功");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
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
    expect(messages[1]?.displayText).toBe("第二条成功");
    store.destroy();
  });

  test("keeps the generated result even when cache persistence fails", async () => {
    const cache = {
      load: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error("cache write denied")),
    };
    const generate = vi.fn().mockResolvedValue("仍然展示结果");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache: cache as any,
      translator: { generate } as any,
    });

    await store.setMessages([createMessage("msg-1", "Show result even without cache")]);
    await waitForCondition(() => store.getMessages()[0]?.translationStatus === "translated");

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe("仍然展示结果");
    expect(message?.translationStatus).toBe("translated");
    store.destroy();
  });

  test("serializes translation requests for long transcripts", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    let concurrent = 0;
    let maxConcurrent = 0;
    const generate = vi.fn().mockImplementation(async (message: ParsedMessage) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, message.messageId === "msg-1" ? 40 : 10));
      concurrent -= 1;
      return `${message.originalText} translated`;
    });
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      createMessage("msg-1", "First"),
      createMessage("msg-2", "Second"),
      createMessage("msg-3", "Third"),
    ]);
    await waitForCondition(() => store.getMessages().every((message) => message?.translationStatus === "translated"));

    expect(maxConcurrent).toBe(1);
    expect(store.getMessages().map((message) => message.displayText)).toEqual([
      "First translated",
      "Second translated",
      "Third translated",
    ]);
    store.destroy();
  });

  test("shows Chinese assistant prose immediately without calling the translator", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([createMessage("msg-1", "我先检查一下当前会话里到底有哪些消息类型。")]);

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe("我先检查一下当前会话里到底有哪些消息类型。");
    expect(message?.translationStatus).toBe("cached");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("shows a local placeholder summary immediately for technical blocks", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage("msg-1", "agent-translator tui --latest --provider codex"),
        kind: "command",
        displayMode: "summarize",
      },
    ]);

    const immediate = store.getMessages()[0];
    expect(immediate?.displayText).toBe("打开 TUI · agent-translator tui");
    expect(immediate?.translationStatus).toBe("cached");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("summarizes merged command activity into short Chinese lines", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn().mockResolvedValue("unused");
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage("msg-1", "npm run test\u0001git status\u0001osascript -e 'tell application \"Terminal\" to do script \"echo hi\"'"),
        kind: "command",
        displayMode: "summarize",
      },
    ]);

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe("运行测试 · npm run test\nGit 状态 · git status\nTerminal 窗口 · osascript");
    expect(message?.translationStatus).toBe("cached");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("adds workdir and edited file details to local command and tool summaries", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage(
          "msg-1",
          "/Users/baakarshan/Developer/products/agent-translator\u0000npm run build",
        ),
        kind: "command",
        displayMode: "summarize",
      },
      {
        ...createMessage(
          "msg-2",
          "apply_patch\u0000/Users/baakarshan/Developer/products/agent-translator/src/tui/app.tsx\u0001/Users/baakarshan/Developer/products/agent-translator/README.md",
        ),
        kind: "tool",
        displayMode: "summarize",
      },
    ]);

    const messages = store.getMessages();
    expect(messages[0]?.displayText).toBe("执行构建 · npm run build · .../products/agent-translator");
    expect(messages[1]?.displayText).toBe(
      "修改了 .../agent-translator/src/tui/app.tsx、.../agent-translator/README.md。",
    );
    expect(messages[0]?.translationStatus).toBe("cached");
    expect(messages[1]?.translationStatus).toBe("cached");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("keeps command summaries to one short line with keywords", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage(
          "msg-1",
          [
            "/Users/baakarshan/Developer/products/agent-translator\u0000rg -n \"followTail\" src/tui/app.tsx",
            "/Users/baakarshan/Developer/products/agent-translator\u0000sed -n '1,80p' src/tui/app.tsx",
            "/Users/baakarshan/Developer/products/agent-translator\u0000find /Users/baakarshan/.codex/sessions -name 'rollout-*.jsonl'",
          ].join("\u0001"),
        ),
        kind: "command",
        displayMode: "summarize",
      },
    ]);

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe(
      "搜索 · followTail · src/tui/app.tsx\n查看 · src/tui/app.tsx\n查找 · rollout-*.jsonl · .../.codex/sessions",
    );
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("summarizes a multiline heredoc command as one line", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage(
          "msg-1",
          "/Users/baakarshan/Developer/products/agent-translator\u0000node --input-type=module <<'EOF'\nconsole.log('hi')\nEOF",
        ),
        kind: "command",
        displayMode: "summarize",
      },
    ]);

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe("Node 脚本 · node · .../products/agent-translator");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });

  test("recognizes npm scripts even when npm flags come first", async () => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-translator-cache-"));
    const cache = new TranslationCache(path.join(temporaryDir, "translations.json"));
    const generate = vi.fn();
    const store = new TranscriptTranslationStore({
      config: baseConfig,
      cache,
      translator: { generate } as any,
    });

    await store.setMessages([
      {
        ...createMessage(
          "msg-1",
          "/Users/baakarshan/Developer/products/agent-translator\u0000npm --cache /tmp/agent-translator-npm-cache -C /Users/baakarshan/Developer/products/agent-translator run typecheck",
        ),
        kind: "command",
        displayMode: "summarize",
      },
    ]);

    const message = store.getMessages()[0];
    expect(message?.displayText).toBe("类型检查 · npm run typecheck · .../products/agent-translator");
    expect(generate).not.toHaveBeenCalled();
    store.destroy();
  });
});
