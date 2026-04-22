import { createHash } from "node:crypto";

import type { DisplayMode, MessageKind, MessageRole, ParsedMessage, ProviderId } from "../types.js";

export interface RawParsedMessage {
  role: MessageRole;
  text: string;
  timestamp: string;
  kind?: MessageKind | undefined;
  displayMode?: DisplayMode | undefined;
}

const COMMAND_PREFIXES = new Set([
  "$",
  "agent-translator",
  "bash",
  "bun",
  "cargo",
  "cat",
  "cd",
  "claude",
  "codex",
  "cp",
  "curl",
  "docker",
  "find",
  "git",
  "go",
  "jq",
  "kubectl",
  "ls",
  "mkdir",
  "mv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "rg",
  "rm",
  "sed",
  "sh",
  "tsx",
  "uv",
  "yarn",
  "zsh",
]);

function normalizeBlock(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function displayModeForKind(kind: MessageKind): DisplayMode {
  if (kind === "prose" || kind === "table") {
    return "translate";
  }
  return "summarize";
}

function isReasoningTextBlock(text: string): boolean {
  const normalized = normalizeBlock(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<think>") ||
    normalized.startsWith("```thinking") ||
    normalized.startsWith("```reasoning") ||
    normalized.startsWith("reasoning:") ||
    normalized.startsWith("thinking:")
  );
}

function splitIntoBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  const fencePattern = /```[\s\S]*?```/g;
  let lastIndex = 0;

  for (const match of normalized.matchAll(fencePattern)) {
    const [fullMatch] = match;
    const matchIndex = match.index ?? 0;
    const prose = normalized.slice(lastIndex, matchIndex);
    if (prose.trim()) {
      blocks.push(...prose.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean));
    }
    blocks.push(fullMatch.trim());
    lastIndex = matchIndex + fullMatch.length;
  }

  const trailing = normalized.slice(lastIndex);
  if (trailing.trim()) {
    blocks.push(...trailing.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean));
  }

  return blocks;
}

function parseFence(block: string): { language: string; body: string } | null {
  const match = block.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```$/);
  if (!match) {
    return null;
  }
  return {
    language: match[1]?.trim().toLowerCase() ?? "",
    body: match[2]?.trim() ?? "",
  };
}

function isMarkdownTableBlock(block: string): boolean {
  const lines = normalizeBlock(block).split("\n");
  if (lines.length < 2) {
    return false;
  }
  const separator = lines[1]?.trim() ?? "";
  return lines[0]!.includes("|") && /^\|?[:\-\s|]+\|?$/.test(separator);
}

function isCommandLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("$ ")) {
    return true;
  }

  const firstToken = trimmed.split(/\s+/)[0]?.replace(/:$/, "") ?? "";
  return COMMAND_PREFIXES.has(firstToken);
}

function isCommandBlock(block: string): boolean {
  const lines = normalizeBlock(block).split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > 6) {
    return false;
  }
  return lines.every(isCommandLine);
}

function isDiffBlock(block: string): boolean {
  const normalized = normalizeBlock(block);
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("diff --git") ||
    normalized.startsWith("--- ") ||
    normalized.startsWith("+++ ") ||
    normalized.includes("\n@@") ||
    normalized.includes("\n--- ") ||
    normalized.includes("\n+++ ")
  );
}

function isShellBlock(block: string): boolean {
  const normalized = normalizeBlock(block);
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("Traceback") ||
    normalized.startsWith("Error:") ||
    normalized.startsWith("zsh:") ||
    normalized.startsWith("npm ERR!") ||
    normalized.startsWith("Last login:") ||
    normalized.includes("\n    at ") ||
    normalized.includes("\nError:") ||
    normalized.includes("\n❯ ") ||
    normalized.includes("command not found")
  );
}

function classifyAssistantBlock(block: string): { kind: MessageKind; displayMode: DisplayMode; text: string } | null {
  const normalized = normalizeBlock(block);
  if (!normalized || isReasoningTextBlock(normalized)) {
    return null;
  }

  const fence = parseFence(normalized);
  if (fence) {
    if (fence.language === "diff" || fence.language === "patch" || isDiffBlock(fence.body)) {
      return { kind: "diff", displayMode: displayModeForKind("diff"), text: normalized };
    }
    if (
      ["bash", "sh", "zsh", "shell", "console"].includes(fence.language) &&
      isCommandBlock(fence.body)
    ) {
      return { kind: "command", displayMode: displayModeForKind("command"), text: normalized };
    }
    return { kind: "code", displayMode: displayModeForKind("code"), text: normalized };
  }

  if (isMarkdownTableBlock(normalized)) {
    return { kind: "table", displayMode: displayModeForKind("table"), text: normalized };
  }
  if (isDiffBlock(normalized)) {
    return { kind: "diff", displayMode: displayModeForKind("diff"), text: normalized };
  }
  if (isCommandBlock(normalized)) {
    return { kind: "command", displayMode: displayModeForKind("command"), text: normalized };
  }
  if (isShellBlock(normalized)) {
    return { kind: "shell", displayMode: displayModeForKind("shell"), text: normalized };
  }

  return { kind: "prose", displayMode: displayModeForKind("prose"), text: normalized };
}

export function splitAssistantMessage(raw: RawParsedMessage): RawParsedMessage[] {
  if (raw.role !== "assistant") {
    return [raw];
  }
  if (raw.kind && raw.displayMode) {
    return [{ ...raw, text: normalizeBlock(raw.text) }];
  }

  const blocks = splitIntoBlocks(raw.text);
  const segments = blocks
    .map(classifyAssistantBlock)
    .filter((segment): segment is { kind: MessageKind; displayMode: DisplayMode; text: string } => Boolean(segment))
    .map((segment) => ({
      role: raw.role,
      text: segment.text,
      timestamp: raw.timestamp,
      kind: segment.kind,
      displayMode: segment.displayMode,
    }));

  return segments.length > 0 ? segments : [];
}

export function splitCompleteJsonlLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const hasTrailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (!hasTrailingNewline && lines.length > 0) {
    lines.pop();
  }
  return lines.filter((line) => line.trim().length > 0);
}

export function truncateTitle(text: string, maxLength = 72): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export function makeMessageId(
  provider: ProviderId,
  sessionId: string,
  role: MessageRole,
  index: number,
): string {
  return `${provider}:${sessionId}:${role}:${index}`;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function dedupeAdjacentMessages(messages: RawParsedMessage[]): RawParsedMessage[] {
  const deduped: RawParsedMessage[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) {
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function mergeAdjacentAssistantNarrative(messages: RawParsedMessage[]): RawParsedMessage[] {
  const merged: RawParsedMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const canMerge = previous
      && previous.role === "assistant"
      && message.role === "assistant"
      && (previous.kind ?? "prose") === "prose"
      && (message.kind ?? "prose") === "prose"
      && (previous.displayMode ?? "translate") === "translate"
      && (message.displayMode ?? "translate") === "translate";

    if (canMerge) {
      previous.text = `${previous.text}\n\n${message.text}`;
      previous.timestamp = message.timestamp;
      continue;
    }

    merged.push({ ...message });
  }

  return merged;
}

export function finalizeMessages(
  provider: ProviderId,
  sessionId: string,
  messages: RawParsedMessage[],
): ParsedMessage[] {
  const expanded = dedupeAdjacentMessages(messages).flatMap((message) => {
    if (message.role === "assistant") {
      return splitAssistantMessage(message);
    }
    return [
      {
        ...message,
        kind: message.kind ?? "prose",
        displayMode: message.displayMode ?? "translate",
      },
    ];
  });
  const merged = mergeAdjacentAssistantNarrative(expanded);

  return merged.map((message, index) => ({
    provider,
    sessionId,
    messageId: makeMessageId(provider, sessionId, message.role, index),
    role: message.role,
    kind: message.kind ?? "unknown",
    displayMode: message.displayMode ?? displayModeForKind(message.kind ?? "unknown"),
    originalText: message.text,
    summaryText: null,
    displayText: null,
    timestamp: message.timestamp,
  }));
}

export function readTimestamp(entry: unknown, fallback: string): string {
  if (!entry || typeof entry !== "object") {
    return fallback;
  }
  const record = entry as { timestamp?: unknown };
  return typeof record.timestamp === "string" ? record.timestamp : fallback;
}

export function isSyntheticCodexUserMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("# agents.md instructions for") && normalized.includes("<instructions>")) {
    return true;
  }
  if (normalized.startsWith("<environment_context>")) {
    return true;
  }
  return false;
}

export function isClaudeNoiseText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === "(no content)") {
    return true;
  }
  if (normalized.startsWith("bash(") || normalized.startsWith("$ ")) {
    return true;
  }
  return false;
}

function isReasoningBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return normalized.includes("thinking") || normalized.includes("reasoning");
}

export function extractClaudeTextBlocks(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed && !isClaudeNoiseText(trimmed) && !isReasoningTextBlock(trimmed) ? trimmed : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { text?: unknown; input?: unknown; type?: unknown };
    if (isReasoningBlockType(candidate.type)) {
      continue;
    }
    if (typeof candidate.text === "string") {
      const trimmed = candidate.text.trim();
      if (trimmed && !isClaudeNoiseText(trimmed) && !isReasoningTextBlock(trimmed)) {
        blocks.push(trimmed);
      }
      continue;
    }
    if (typeof candidate.input === "string") {
      const trimmed = candidate.input.trim();
      if (trimmed && !isClaudeNoiseText(trimmed) && !isReasoningTextBlock(trimmed)) {
        blocks.push(trimmed);
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join("\n\n");
}
