import { createHash } from "node:crypto";

import type { MessageRole, ParsedMessage, ProviderId } from "../types.js";

export interface RawParsedMessage {
  role: MessageRole;
  text: string;
  timestamp: string;
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

export function finalizeMessages(
  provider: ProviderId,
  sessionId: string,
  messages: RawParsedMessage[],
): ParsedMessage[] {
  return dedupeAdjacentMessages(messages).map((message, index) => ({
    provider,
    sessionId,
    messageId: makeMessageId(provider, sessionId, message.role, index),
    role: message.role,
    originalText: message.text,
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

export function extractClaudeTextBlocks(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed && !isClaudeNoiseText(trimmed) ? trimmed : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { text?: unknown; input?: unknown };
    if (typeof candidate.text === "string") {
      const trimmed = candidate.text.trim();
      if (trimmed && !isClaudeNoiseText(trimmed)) {
        blocks.push(trimmed);
      }
      continue;
    }
    if (typeof candidate.input === "string") {
      const trimmed = candidate.input.trim();
      if (trimmed && !isClaudeNoiseText(trimmed)) {
        blocks.push(trimmed);
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join("\n\n");
}

