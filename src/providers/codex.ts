import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SessionDescriptor, SessionSnapshot } from "../types.js";
import {
  displayModeForKind,
  finalizeMessages,
  isSyntheticCodexUserMessage,
  readTimestamp,
  splitCompleteJsonlLines,
  truncateTitle,
  type RawParsedMessage,
} from "./common.js";

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { text?: unknown; message?: unknown; type?: unknown };
      if (typeof candidate.type === "string") {
        const normalizedType = candidate.type.toLowerCase();
        if (normalizedType.includes("thinking") || normalizedType.includes("reasoning")) {
          return "";
        }
      }
      if (typeof candidate.text === "string") {
        return candidate.text.trim();
      }
      if (typeof candidate.message === "string") {
        return candidate.message.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractEventMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message.trim();
  }
  if (!message || typeof message !== "object") {
    return "";
  }
  const candidate = message as { text?: unknown; message?: unknown };
  if (typeof candidate.message === "string") {
    return candidate.message.trim();
  }
  if (typeof candidate.text === "string") {
    return candidate.text.trim();
  }
  return "";
}

function extractStringField(record: unknown, field: string): string | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseResponseItem(entry: Record<string, unknown>, fallbackTimestamp: string): RawParsedMessage | null {
  const payload = (entry.payload ?? entry.item) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.type === "message") {
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
    if (!role) {
      return null;
    }
    const text = extractMessageText(payload.content);
    if (!text) {
      return null;
    }
    if (role === "user" && isSyntheticCodexUserMessage(text)) {
      return null;
    }
    return {
      role,
      text,
      timestamp: readTimestamp(entry, fallbackTimestamp),
    };
  }

  if (payload.type === "function_call" && typeof payload.name === "string") {
    const argumentsText = typeof payload.arguments === "string" ? payload.arguments.trim() : "";
    const parsedArguments = argumentsText ? parseToolArguments(argumentsText) : null;

    if (payload.name === "exec_command") {
      const commandText = extractStringField(parsedArguments, "cmd") ?? "exec_command";
      return {
        role: "assistant",
        text: commandText,
        kind: "command",
        displayMode: displayModeForKind("command"),
        timestamp: readTimestamp(entry, fallbackTimestamp),
      };
    }

    return {
      role: "assistant",
      text: payload.name,
      kind: "tool",
      displayMode: displayModeForKind("tool"),
      timestamp: readTimestamp(entry, fallbackTimestamp),
    };
  }

  if (payload.type === "custom_tool_call" && typeof payload.name === "string") {
    return {
      role: "assistant",
      text: payload.name,
      kind: "tool",
      displayMode: displayModeForKind("tool"),
      timestamp: readTimestamp(entry, fallbackTimestamp),
    };
  }

  return null;
}

function parseEventMessage(entry: Record<string, unknown>, fallbackTimestamp: string): RawParsedMessage | null {
  const payload = (entry.payload ?? entry.msg) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.type === "agent_message") {
    const text = extractEventMessageText(payload.message);
    if (!text) {
      return null;
    }
    return {
      role: "assistant",
      text,
      timestamp: readTimestamp(entry, fallbackTimestamp),
    };
  }

  if (payload.type === "user_message") {
    const text = extractEventMessageText(payload.message);
    if (!text || isSyntheticCodexUserMessage(text)) {
      return null;
    }
    return {
      role: "user",
      text,
      timestamp: readTimestamp(entry, fallbackTimestamp),
    };
  }

  return null;
}

export async function parseCodexSessionFile(filePath: string): Promise<SessionSnapshot | null> {
  const [content, fileStats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
  const fallbackTimestamp = fileStats.mtime.toISOString();

  let sessionId = path.basename(filePath).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
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
    const payload = (entry.payload ?? entry.item ?? entry.msg) as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object" && entry.type === "session_meta") {
      if (typeof payload.id === "string" && payload.id.trim()) {
        sessionId = payload.id;
      }
      if (typeof payload.cwd === "string" && payload.cwd.trim()) {
        cwd = payload.cwd;
      }
      continue;
    }

    const responseMessage = entry.type === "response_item" ? parseResponseItem(entry, fallbackTimestamp) : null;
    if (responseMessage) {
      messages.push(responseMessage);
      continue;
    }

    const eventMessage = entry.type === "event_msg" ? parseEventMessage(entry, fallbackTimestamp) : null;
    if (eventMessage) {
      messages.push(eventMessage);
    }
  }

  if (!cwd) {
    cwd = path.dirname(path.dirname(path.dirname(path.dirname(filePath))));
  }

  const finalizedMessages = finalizeMessages("codex", sessionId, messages);
  const firstUserMessage = finalizedMessages.find((message) => message.role === "user");
  const title = firstUserMessage
    ? truncateTitle(firstUserMessage.originalText)
    : `Codex session ${sessionId.slice(0, 8)}`;

  return {
    provider: "codex",
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

export async function readCodexDescriptor(filePath: string): Promise<SessionDescriptor | null> {
  const snapshot = await parseCodexSessionFile(filePath);
  if (!snapshot) {
    return null;
  }
  const { messages: _messages, ...descriptor } = snapshot;
  return descriptor;
}
