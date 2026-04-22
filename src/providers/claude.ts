import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SessionDescriptor, SessionSnapshot } from "../types.js";
import {
  extractClaudeTextBlocks,
  finalizeMessages,
  isClaudeNoiseText,
  readTimestamp,
  splitCompleteJsonlLines,
  truncateTitle,
  type RawParsedMessage,
} from "./common.js";

function isSyntheticUserEntry(entry: Record<string, unknown>): boolean {
  return entry.isSynthetic === true || entry.isMeta === true || entry.isSidechain === true;
}

function extractVisibleAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as { content?: unknown; text?: unknown };
  if (typeof candidate.text === "string") {
    const trimmed = candidate.text.trim();
    return trimmed && !isClaudeNoiseText(trimmed) ? trimmed : null;
  }
  return extractClaudeTextBlocks(candidate.content);
}

export async function parseClaudeSessionFile(filePath: string): Promise<SessionSnapshot | null> {
  const [content, fileStats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
  const fallbackTimestamp = fileStats.mtime.toISOString();

  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = "";
  const messages: RawParsedMessage[] = [];

  for (const line of splitCompleteJsonlLines(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const entry = parsed as Record<string, unknown>;
    if (entry.isSidechain === true) {
      continue;
    }

    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      sessionId = entry.sessionId;
    }
    if (!cwd && typeof entry.cwd === "string" && entry.cwd.trim()) {
      cwd = entry.cwd;
    }

    if (entry.type === "user") {
      if (isSyntheticUserEntry(entry)) {
        continue;
      }
      const text = extractVisibleAssistantText(entry.message);
      if (text) {
        messages.push({
          role: "user",
          text,
          timestamp: readTimestamp(entry, fallbackTimestamp),
        });
      }
      continue;
    }

    if (entry.type === "assistant") {
      const text = extractVisibleAssistantText(entry.message);
      if (text) {
        messages.push({
          role: "assistant",
          text,
          timestamp: readTimestamp(entry, fallbackTimestamp),
        });
      }
    }
  }

  if (!cwd) {
    cwd = path.dirname(path.dirname(filePath));
  }

  const finalizedMessages = finalizeMessages("claude", sessionId, messages);
  const firstUserMessage = finalizedMessages.find((message) => message.role === "user");
  const title = firstUserMessage
    ? truncateTitle(firstUserMessage.originalText)
    : `Claude session ${sessionId.slice(0, 8)}`;

  return {
    provider: "claude",
    sessionId,
    filePath,
    cwd,
    title,
    lastActivityAt: fallbackTimestamp,
    lastActivityMs: fileStats.mtimeMs,
    live: Date.now() - fileStats.mtimeMs < 30_000,
    messages: finalizedMessages,
  };
}

export async function readClaudeDescriptor(filePath: string): Promise<SessionDescriptor | null> {
  const snapshot = await parseClaudeSessionFile(filePath);
  if (!snapshot) {
    return null;
  }
  const { messages: _messages, ...descriptor } = snapshot;
  return descriptor;
}
