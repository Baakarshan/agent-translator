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

export class TranscriptTranslationStore extends EventEmitter {
  private readonly config: TranslatorConfig;
  private readonly translator: TranslatorClient;
  private readonly cache: TranslationCache;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly messageStates = new Map<string, MessageState>();
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
    this.order = [];
  }

  private scheduleTranslation(messageId: string, fingerprint: string): void {
    this.clearTimer(messageId);
    const timer = setTimeout(() => {
      void this.runTranslation(messageId, fingerprint);
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
