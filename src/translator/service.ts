import { EventEmitter } from "node:events";

import { hashText } from "../providers/common.js";
import type { DisplayMessage, ParsedMessage, TranslatorConfig } from "../types.js";
import { TranslationCache } from "./cache.js";
import { TranslatorClient } from "./client.js";

type MessageState = DisplayMessage & {
  fingerprint: string;
};

function toFingerprint(config: TranslatorConfig, message: ParsedMessage): string {
  return hashText(`${config.model}\u0000${config.promptVersion}\u0000${message.kind}\u0000${message.originalText}`);
}

function toDisplayMessage(message: ParsedMessage): DisplayMessage {
  return {
    ...message,
    summaryText: null,
    displayText: null,
    translationStatus: "idle",
  };
}

function isLikelyChineseText(text: string): boolean {
  const cjkMatches = text.match(/[\u3400-\u9fff]/g) ?? [];
  const latinMatches = text.match(/[A-Za-z]/g) ?? [];
  return cjkMatches.length >= 6 && cjkMatches.length >= latinMatches.length;
}

function buildLocalDisplayText(message: ParsedMessage): string | null {
  if (message.displayMode !== "summarize") {
    return null;
  }

  const normalized = message.originalText.toLowerCase();

  if (message.kind === "command") {
    if (normalized.includes("agent-translator tui")) {
      return "给出了一条打开翻译 TUI 的命令。";
    }
    if (normalized.includes("npm run verify")) {
      return "给出了一条运行项目校验流程的命令。";
    }
    if (normalized.includes("git")) {
      return "给出了一条 Git 相关命令。";
    }
    return "给出了一条命令示例。";
  }

  if (message.kind === "code") {
    return "给出了一段代码示例。";
  }

  if (message.kind === "diff") {
    return "展示了一段改动差异。";
  }

  if (message.kind === "shell") {
    if (normalized.includes("error:") || normalized.includes("traceback") || normalized.includes("npm err!")) {
      return "展示了一段报错或异常输出。";
    }
    return "展示了一段命令执行结果。";
  }

  if (message.kind === "tool") {
    return "调用了一个工具来完成当前操作。";
  }

  return null;
}

export class TranscriptTranslationStore extends EventEmitter {
  private readonly config: TranslatorConfig;
  private readonly translator: TranslatorClient;
  private readonly cache: TranslationCache;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly messageStates = new Map<string, MessageState>();
  private readonly queue: Array<{ messageId: string; fingerprint: string }> = [];
  private activeTranslationKey: string | null = null;
  private order: string[] = [];

  constructor(params: {
    config: TranslatorConfig;
    translator?: TranslatorClient;
    cache?: TranslationCache;
  }) {
    super();
    this.config = params.config;
    this.translator = params.translator ?? new TranslatorClient(params.config);
    this.cache = params.cache ?? new TranslationCache();
  }

  public getMessages(): DisplayMessage[] {
    return this.order
      .map((messageId) => this.messageStates.get(messageId))
      .filter((message): message is MessageState => Boolean(message))
      .map(({ fingerprint: _fingerprint, ...message }) => message);
  }

  public async setMessages(messages: ParsedMessage[]): Promise<void> {
    await this.cache.load();

    const nextIds = new Set(messages.map((message) => message.messageId));
    for (const existingId of this.messageStates.keys()) {
      if (!nextIds.has(existingId)) {
        this.clearTimer(existingId);
        this.messageStates.delete(existingId);
        this.removeQueuedTranslation(existingId);
      }
    }

    this.order = messages.map((message) => message.messageId);

    for (const message of messages) {
      const fingerprint = toFingerprint(this.config, message);
      const previous = this.messageStates.get(message.messageId);

      if (message.role === "user") {
        this.clearTimer(message.messageId);
        this.messageStates.set(message.messageId, {
          ...toDisplayMessage(message),
          displayText: message.originalText,
          translationStatus: "idle",
          fingerprint,
        });
        continue;
      }

      if (
        message.displayMode === "translate" &&
        (message.kind === "prose" || message.kind === "table") &&
        isLikelyChineseText(message.originalText)
      ) {
        this.clearTimer(message.messageId);
        this.messageStates.set(message.messageId, {
          ...toDisplayMessage(message),
          displayText: message.originalText,
          translationStatus: "cached",
          fingerprint,
        });
        continue;
      }

      if (previous && previous.fingerprint === fingerprint) {
        this.messageStates.set(message.messageId, {
          ...message,
          summaryText: previous.summaryText,
          displayText: previous.displayText,
          translationStatus: previous.translationStatus,
          translationError: previous.translationError,
          fingerprint,
        });
        continue;
      }

      const cached = await this.cache.get(fingerprint);
      if (cached) {
        this.clearTimer(message.messageId);
        this.messageStates.set(message.messageId, {
          ...toDisplayMessage(message),
          summaryText: message.displayMode === "summarize" ? cached : null,
          displayText: cached,
          translationStatus: "cached",
          fingerprint,
        });
        continue;
      }

      this.messageStates.set(message.messageId, {
        ...toDisplayMessage(message),
        summaryText: message.displayMode === "summarize" ? buildLocalDisplayText(message) : null,
        displayText: buildLocalDisplayText(message),
        translationStatus: "scheduled",
        fingerprint,
      });
      this.scheduleTranslation(message.messageId, fingerprint);
    }

    this.emit("update", this.getMessages());
  }

  public destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.messageStates.clear();
    this.queue.length = 0;
    this.activeTranslationKey = null;
    this.order = [];
  }

  private scheduleTranslation(messageId: string, fingerprint: string): void {
    this.clearTimer(messageId);
    const timer = setTimeout(() => {
      this.enqueueTranslation(messageId, fingerprint);
    }, this.config.debounceMs);
    this.timers.set(messageId, timer);
  }

  private clearTimer(messageId: string): void {
    const timer = this.timers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(messageId);
    }
  }

  private enqueueTranslation(messageId: string, fingerprint: string): void {
    const current = this.messageStates.get(messageId);
    if (!current || current.fingerprint !== fingerprint) {
      return;
    }

    const activeKey = `${messageId}:${fingerprint}`;
    if (this.activeTranslationKey === activeKey) {
      return;
    }
    if (this.queue.some((item) => item.messageId === messageId && item.fingerprint === fingerprint)) {
      return;
    }

    this.queue.push({ messageId, fingerprint });
    void this.processQueue();
  }

  private removeQueuedTranslation(messageId: string): void {
    const nextQueue = this.queue.filter((item) => item.messageId !== messageId);
    this.queue.length = 0;
    this.queue.push(...nextQueue);
  }

  private async processQueue(): Promise<void> {
    if (this.activeTranslationKey) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const current = this.messageStates.get(next.messageId);
    if (!current || current.fingerprint !== next.fingerprint) {
      void this.processQueue();
      return;
    }

    this.activeTranslationKey = `${next.messageId}:${next.fingerprint}`;
    try {
      await this.runTranslation(next.messageId, next.fingerprint);
    } finally {
      if (this.activeTranslationKey === `${next.messageId}:${next.fingerprint}`) {
        this.activeTranslationKey = null;
      }
      void this.processQueue();
    }
  }

  private async runTranslation(messageId: string, fingerprint: string): Promise<void> {
    this.clearTimer(messageId);
    const current = this.messageStates.get(messageId);
    if (!current || current.fingerprint !== fingerprint) {
      return;
    }

    this.messageStates.set(messageId, {
      ...current,
      translationStatus: "translating",
      translationError: undefined,
    });
    this.emit("update", this.getMessages());

    try {
      const generatedText = await this.translator.generate(current);
      const latest = this.messageStates.get(messageId);
      if (!latest || latest.fingerprint !== fingerprint) {
        return;
      }
      try {
        await this.cache.set(fingerprint, generatedText);
      } catch {
        // Cache persistence failure should not block the visible result.
      }
      this.messageStates.set(messageId, {
        ...latest,
        summaryText: latest.displayMode === "summarize" ? generatedText : null,
        displayText: generatedText,
        translationStatus: "translated",
        translationError: undefined,
      });
    } catch (error) {
      const latest = this.messageStates.get(messageId);
      if (!latest || latest.fingerprint !== fingerprint) {
        return;
      }
      this.messageStates.set(messageId, {
        ...latest,
        summaryText: null,
        displayText: null,
        translationStatus: "failed",
        translationError: error instanceof Error ? error.message : String(error),
      });
    }

    this.emit("update", this.getMessages());
  }
}
