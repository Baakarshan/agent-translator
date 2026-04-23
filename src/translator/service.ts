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

function shortenPath(value: string, tailSegments = 3): string {
  const normalized = value.trim().replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    return normalized;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= tailSegments) {
    return `/${parts.join("/")}`;
  }

  return `.../${parts.slice(-tailSegments).join("/")}`;
}

function shortenKeyword(value: string, maxLength = 24): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function shortenFilePath(value: string): string {
  const normalized = value.trim().replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    return normalized;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return `/${parts.join("/")}`;
  }

  const markerIndex = parts.findLastIndex((part) =>
    ["src", "app", "lib", "packages", "docs", "test", "tests"].includes(part),
  );

  if (markerIndex > 0 && parts.length - markerIndex <= 3) {
    return `.../${parts.slice(markerIndex - 1).join("/")}`;
  }

  return `.../${parts.slice(-2).join("/")}`;
}

function formatLocation(value: string | null, workdir: string | null, kind: "file" | "path"): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/\/+/g, "/");
  if (!normalized) {
    return null;
  }

  if (workdir && normalized.startsWith(`${workdir}/`)) {
    return normalized.slice(workdir.length + 1);
  }

  if (!normalized.startsWith("/")) {
    return normalized;
  }

  return kind === "file" ? shortenFilePath(normalized) : shortenPath(normalized, 2);
}

function withScope(label: string, workdir: string | null): string {
  const scope = formatLocation(workdir, null, "path");
  return scope ? `${label} · ${scope}` : label;
}

function withCommand(label: string, commandKeyword: string, workdir: string | null): string {
  const parts = [label, commandKeyword];
  const scope = formatLocation(workdir, null, "path");
  if (scope) {
    parts.push(scope);
  }
  return parts.join(" · ");
}

function extractNpmRunScript(command: string): string | null {
  const match = command.match(/(?:^|\s)run\s+([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

function parseCommandEntry(entry: string): { workdir: string | null; command: string } {
  const separatorIndex = entry.indexOf("\u0000");
  if (separatorIndex === -1) {
    return { workdir: null, command: entry.trim() };
  }

  return {
    workdir: entry.slice(0, separatorIndex).trim() || null,
    command: entry.slice(separatorIndex + 1).trim(),
  };
}

function unwrapFencedCommand(command: string): string {
  const match = command.trim().match(/^```([^\n`]*)\n?([\s\S]*?)\n?```$/);
  if (!match) {
    return command.trim();
  }

  const language = match[1]?.trim().toLowerCase() ?? "";
  if (!["bash", "sh", "zsh", "shell", "console"].includes(language)) {
    return command.trim();
  }

  return match[2]?.trim() ?? command.trim();
}

function summarizeCommandLine(entry: string): string {
  const { workdir, command: rawCommand } = parseCommandEntry(entry);
  const command = unwrapFencedCommand(rawCommand);
  const normalized = command.toLowerCase();

  if (normalized.startsWith("/")) {
    if (normalized === "/exit") {
      return "结束会话 · /exit";
    }
    if (normalized.startsWith("/model")) {
      return "Claude 命令 · /model";
    }
    return `Claude 命令 · ${shortenKeyword(command, 20)}`;
  }
  if (normalized.includes("agent-translator tui")) {
    return withCommand("打开 TUI", "agent-translator tui", workdir);
  }
  if (normalized.startsWith("npm ") || normalized.includes(" npm ")) {
    const npmScript = extractNpmRunScript(command);
    if (npmScript === "verify") {
      return withCommand("运行校验", "npm run verify", workdir);
    }
    if (npmScript === "test") {
      return withCommand("运行测试", "npm run test", workdir);
    }
    if (npmScript === "build") {
      return withCommand("执行构建", "npm run build", workdir);
    }
    if (npmScript === "typecheck") {
      return withCommand("类型检查", "npm run typecheck", workdir);
    }
    if (npmScript === "install:global") {
      return withCommand("全局安装", "npm run install:global", workdir);
    }
    if (npmScript) {
      return withCommand("运行脚本", `npm run ${npmScript}`, workdir);
    }
    return withCommand("npm", "npm", workdir);
  }
  if (normalized.startsWith("git ") || normalized.includes(" git ")) {
    if (normalized.includes("status")) {
      return withCommand("Git 状态", "git status", workdir);
    }
    if (normalized.includes("diff")) {
      return withCommand("Git 差异", "git diff", workdir);
    }
    if (normalized.includes("add ")) {
      return withCommand("Git 暂存", "git add", workdir);
    }
    if (normalized.includes("commit")) {
      return withCommand("Git 提交", "git commit", workdir);
    }
    return withCommand("Git", shortenKeyword(command, 20), workdir);
  }
  if (normalized.startsWith("rg ") || normalized.includes(" rg ")) {
    const match = command.match(/(?:^|\s)rg(?:\s+-\S+|\s+--\S+(?:=\S+)*)*\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+(.+))?$/);
    const keyword = shortenKeyword(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
    const target = formatLocation(match?.[4]?.trim() ?? null, workdir, "path");
    const parts = ["搜索"];
    if (keyword) {
      parts.push(keyword);
    }
    if (target) {
      parts.push(target);
    } else if (workdir) {
      parts.push(formatLocation(workdir, null, "path")!);
    }
    return parts.join(" · ");
  }
  if (normalized.startsWith("sed ") || normalized.includes(" sed ")) {
    const match = command.match(/sed\s+-n\s+'[^']*'\s+(.+)$/);
    const target = formatLocation(match?.[1]?.trim() ?? null, workdir, "file");
    return target ? `查看 · ${target}` : withScope("查看片段", workdir);
  }
  if (normalized.startsWith("node ") || normalized.includes("node --input-type=module")) {
    return withCommand("Node 脚本", "node", workdir);
  }
  if (normalized.startsWith("osascript ") || normalized.includes("tell application \"terminal\"")) {
    return "Terminal 窗口 · osascript";
  }
  if (normalized.startsWith("sleep ")) {
    const seconds = command.match(/sleep\s+([0-9.]+)/)?.[1];
    return seconds ? `等待 · ${seconds}s` : "等待";
  }
  if (normalized.startsWith("cat ")) {
    const target = formatLocation(command.replace(/^cat\s+/, "").trim(), workdir, "file");
    return target ? `查看 · ${target}` : withScope("查看", workdir);
  }
  if (normalized.startsWith("ls ")) {
    const target = formatLocation(command.match(/^ls(?:\s+-\S+|\s+--\S+(?:=\S+)*)*\s+(.+)$/)?.[1] ?? null, workdir, "path");
    return target ? `列目录 · ${target}` : withScope("列目录", workdir);
  }
  if (normalized.startsWith("find ")) {
    const base = command.match(/^find\s+([^\s]+)(?:\s+|$)/)?.[1] ?? null;
    const keyword = command.match(/-name\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.[1]
      ?? command.match(/-name\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.[2]
      ?? command.match(/-name\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.[3]
      ?? "";
    const target = formatLocation(base, workdir, "path");
    const parts = ["查找"];
    if (keyword) {
      parts.push(shortenKeyword(keyword));
    }
    if (target) {
      parts.push(target);
    }
    return parts.join(" · ");
  }

  return withScope(`命令 · ${shortenKeyword(command, 18)}`, workdir);
}

function summarizeToolLine(entry: string): string {
  const [rawToolName = "", detail = ""] = entry.split("\u0000", 2);
  const toolName = rawToolName;
  const normalized = toolName.toLowerCase();
  const trimmedDetail = detail.trim();
  if (normalized === "apply_patch") {
    const files = uniqLines(detail.split("\u0001")).map(shortenFilePath);
    if (files.length === 1) {
      return `修改了 ${files[0]}。`;
    }
    if (files.length > 1) {
      return `修改了 ${files.join("、")}。`;
    }
    return "修改了项目文件。";
  }
  if (normalized === "write_stdin") {
    return "向正在运行的进程发送输入。";
  }
  if (normalized === "exec_command") {
    return "调用终端执行命令。";
  }
  if (normalized === "read") {
    return trimmedDetail ? `读取 · ${shortenFilePath(trimmedDetail)}` : "读取了一个文件。";
  }
  if (normalized === "glob") {
    return trimmedDetail ? `查找文件 · ${shortenKeyword(trimmedDetail, 28)}` : "查找了文件。";
  }
  if (normalized === "grep") {
    return trimmedDetail ? `搜索文本 · ${shortenKeyword(trimmedDetail, 28)}` : "搜索了文本。";
  }
  if (normalized === "edit" || normalized === "multiedit" || normalized === "write") {
    return trimmedDetail ? `编辑 · ${shortenFilePath(trimmedDetail)}` : "编辑了文件。";
  }
  if (normalized === "task") {
    return trimmedDetail ? `子任务 · ${shortenKeyword(trimmedDetail, 28)}` : "启动了一个子任务。";
  }
  return "调用了一个工具。";
}

function buildLocalDisplayText(message: ParsedMessage): string | null {
  if (message.displayMode !== "summarize") {
    return null;
  }

  if (message.kind === "command") {
    return uniqLines(message.originalText.split("\u0001").map(summarizeCommandLine)).join("\n");
  }

  if (message.kind === "code") {
    return "给出了一段代码示例。";
  }

  if (message.kind === "diff") {
    return "展示了一段改动差异。";
  }

  if (message.kind === "shell") {
    const normalized = message.originalText.toLowerCase();
    if (normalized.startsWith("goodbye!")) {
      return "结束了 Claude 会话。";
    }
    if (normalized.startsWith("set model to")) {
      return "切换了 Claude 模型。";
    }
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

      if (
        message.displayMode === "summarize" &&
        (message.kind === "command" || message.kind === "tool" || message.kind === "shell")
      ) {
        const localSummary = buildLocalDisplayText(message);
        this.clearTimer(message.messageId);
        this.messageStates.set(message.messageId, {
          ...toDisplayMessage(message),
          summaryText: localSummary,
          displayText: localSummary,
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
      const fallbackDisplayText = latest.displayText ?? buildLocalDisplayText(latest);
      this.messageStates.set(messageId, {
        ...latest,
        summaryText: latest.summaryText ?? fallbackDisplayText,
        displayText: fallbackDisplayText,
        translationStatus: "failed",
        translationError: error instanceof Error ? error.message : String(error),
      });
    }

    this.emit("update", this.getMessages());
  }
}
