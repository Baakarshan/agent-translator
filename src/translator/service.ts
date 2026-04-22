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

function uniqLines(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function summarizeCommandLine(command: string): string {
  const normalized = command.toLowerCase();

  if (normalized.includes("agent-translator tui")) {
    return "打开翻译 TUI。";
  }
  if (normalized.startsWith("npm ") || normalized.includes(" npm ")) {
    if (normalized.includes("run verify")) {
      return "运行项目校验流程。";
    }
    if (normalized.includes("run test")) {
      return "运行测试。";
    }
    if (normalized.includes("run build")) {
      return "执行构建。";
    }
    return "运行项目脚本。";
  }
  if (normalized.startsWith("git ") || normalized.includes(" git ")) {
    if (normalized.includes("status")) {
      return "查看工作区状态。";
    }
    if (normalized.includes("diff")) {
      return "查看改动差异。";
    }
    if (normalized.includes("add ")) {
      return "暂存改动。";
    }
    if (normalized.includes("commit")) {
      return "提交本地改动。";
    }
    return "执行 Git 操作。";
  }
  if (normalized.startsWith("rg ") || normalized.includes(" rg ")) {
    return "搜索文本内容。";
  }
  if (normalized.startsWith("sed ") || normalized.includes(" sed ")) {
    return "查看文件片段。";
  }
  if (normalized.startsWith("node ") || normalized.includes("node --input-type=module")) {
    return "运行临时 Node 脚本。";
  }
  if (normalized.startsWith("osascript ") || normalized.includes("tell application \"terminal\"")) {
    return "控制或读取 Terminal 窗口。";
  }
  if (normalized.startsWith("sleep ")) {
    return "短暂等待结果返回。";
  }
  if (normalized.startsWith("cat ") || normalized.startsWith("find ") || normalized.startsWith("ls ")) {
    return "查看本地文件信息。";
  }

  return "执行了一条命令。";
}

function summarizeToolLine(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized === "apply_patch") {
    return "修改了项目文件。";
  }
  if (normalized === "write_stdin") {
    return "向正在运行的进程发送输入。";
  }
  if (normalized === "exec_command") {
    return "调用终端执行命令。";
  }
  return "调用了一个工具。";
}

function buildLocalDisplayText(message: ParsedMessage): string | null {
  if (message.displayMode !== "summarize") {
    return null;
  }

  if (message.kind === "command") {
    return uniqLines(message.originalText.split("\n").map(summarizeCommandLine)).join("\n");
  }

  if (message.kind === "code") {
    return "给出了一段代码示例。";
  }

  if (message.kind === "diff") {
    return "展示了一段改动差异。";
  }

  if (message.kind === "shell") {
    const normalized = message.originalText.toLowerCase();
    if (normalized.includes("error:") || normalized.includes("traceback") || normalized.includes("npm err!")) {
      return "展示了一段报错或异常输出。";
    }
    return "展示了一段命令执行结果。";
  }

  if (message.kind === "tool") {
    return uniqLines(message.originalText.split("\n").map(summarizeToolLine)).join("\n");
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
