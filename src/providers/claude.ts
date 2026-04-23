import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SessionDescriptor, SessionSnapshot } from "../types.js";
import {
  displayModeForKind,
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

function isClaudeControlText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<command-args>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<local-command-stderr>") ||
    trimmed.startsWith("<local-command-caveat>")
  );
}

function isControlCharacterOnly(text: string): boolean {
  return /^[\u0000-\u001f\u007f\s]+$/.test(text);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function encodeCommandActivity(commandText: string, workdir: string | null): string {
  return workdir ? `${workdir}\u0000${commandText}` : commandText;
}

function encodeToolActivity(toolName: string, detail: string | null): string {
  return detail ? `${toolName}\u0000${detail}` : toolName;
}

function resolveClaudePath(value: string, cwd: string | null): string {
  if (!cwd || !value.startsWith("/workspace/")) {
    return value;
  }
  return path.join(cwd, value.slice("/workspace/".length));
}

function extractTagContent(text: string, tagName: string): string | null {
  const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  const value = match?.[1]?.trim();
  return value ? stripAnsi(value) : null;
}

function extractVisibleToolResultText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as { content?: unknown };
  if (!Array.isArray(candidate.content)) {
    return null;
  }

  for (const block of candidate.content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const toolResult = block as { type?: unknown; content?: unknown; is_error?: unknown };
    if (toolResult.type !== "tool_result" || toolResult.is_error !== true) {
      continue;
    }

    if (typeof toolResult.content === "string") {
      const text = stripAnsi(toolResult.content).trim();
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function extractFirstNonEmptyString(input: unknown, fields: string[]): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function describeClaudeToolInput(toolName: string, input: unknown, cwd: string | null): string | null {
  const normalized = toolName.toLowerCase();

  if (normalized === "read" || normalized === "edit" || normalized === "multiedit" || normalized === "write") {
    const filePath = extractFirstNonEmptyString(input, ["file_path", "path"]);
    return filePath ? resolveClaudePath(filePath, cwd) : null;
  }

  if (normalized === "glob") {
    return extractFirstNonEmptyString(input, ["pattern"]);
  }

  if (normalized === "grep") {
    const pattern = extractFirstNonEmptyString(input, ["pattern", "query"]);
    const searchPath = extractFirstNonEmptyString(input, ["path"]);
    if (pattern && searchPath) {
      return `${pattern} @ ${resolveClaudePath(searchPath, cwd)}`;
    }
    return pattern ?? (searchPath ? resolveClaudePath(searchPath, cwd) : null);
  }

  if (normalized === "task") {
    return extractFirstNonEmptyString(input, ["description", "prompt"]);
  }

  const fallback = extractFirstNonEmptyString(input, [
    "command",
    "cmd",
    "pattern",
    "file_path",
    "path",
    "description",
    "prompt",
    "query",
  ]);

  if (!fallback) {
    return null;
  }

  if (fallback.startsWith("/")) {
    return resolveClaudePath(fallback, cwd);
  }

  return fallback;
}

function parseClaudeToolUse(message: unknown, timestamp: string, cwd: string | null): RawParsedMessage[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const candidate = message as { content?: unknown };
  if (!Array.isArray(candidate.content)) {
    return [];
  }

  const parsed: RawParsedMessage[] = [];
  for (const block of candidate.content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const toolBlock = block as { type?: unknown; name?: unknown; input?: unknown };
    if (toolBlock.type !== "tool_use" || typeof toolBlock.name !== "string" || !toolBlock.name.trim()) {
      continue;
    }

    const toolName = toolBlock.name.trim();
    const normalized = toolName.toLowerCase();
    if (normalized === "bash") {
      const commandText = extractFirstNonEmptyString(toolBlock.input, ["command", "cmd"]) ?? "bash";
      parsed.push({
        role: "assistant",
        text: encodeCommandActivity(commandText, cwd),
        kind: "command",
        displayMode: displayModeForKind("command"),
        timestamp,
      });
      continue;
    }

    parsed.push({
      role: "assistant",
      text: encodeToolActivity(toolName, describeClaudeToolInput(toolName, toolBlock.input, cwd)),
      kind: "tool",
      displayMode: displayModeForKind("tool"),
      timestamp,
    });
  }

  return parsed;
}

function parseClaudeUserControlMessage(message: unknown, timestamp: string, cwd: string | null): RawParsedMessage[] {
  const text = extractVisibleAssistantText(message);
  if (!text) {
    return [];
  }

  const commandName = extractTagContent(text, "command-name");
  if (commandName) {
    const commandMessage = extractTagContent(text, "command-message");
    const commandArgs = extractTagContent(text, "command-args");
    const commandText = [commandName, commandArgs].filter(Boolean).join(" ").trim()
      || commandMessage
      || commandName;
    return [{
      role: "assistant",
      text: encodeCommandActivity(commandText, cwd),
      kind: "command",
      displayMode: displayModeForKind("command"),
      timestamp,
    }];
  }

  const stdoutText = extractTagContent(text, "local-command-stdout");
  if (stdoutText) {
    return [{
      role: "assistant",
      text: stdoutText,
      kind: "shell",
      displayMode: displayModeForKind("shell"),
      timestamp,
    }];
  }

  const stderrText = extractTagContent(text, "local-command-stderr");
  if (stderrText) {
    return [{
      role: "assistant",
      text: stderrText,
      kind: "shell",
      displayMode: displayModeForKind("shell"),
      timestamp,
    }];
  }

  return [];
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
      const timestamp = readTimestamp(entry, fallbackTimestamp);
      const controlMessages = parseClaudeUserControlMessage(entry.message, timestamp, cwd || null);
      if (controlMessages.length > 0) {
        messages.push(...controlMessages);
        continue;
      }

      const toolResultError = extractVisibleToolResultText(entry.message);
      if (toolResultError) {
        messages.push({
          role: "assistant",
          text: toolResultError,
          kind: "shell",
          displayMode: displayModeForKind("shell"),
          timestamp,
        });
        continue;
      }

      const text = extractVisibleAssistantText(entry.message);
      if (text && !isClaudeControlText(text) && !isControlCharacterOnly(text)) {
        messages.push({
          role: "user",
          text,
          timestamp,
        });
      }
      continue;
    }

    if (entry.type === "assistant") {
      const timestamp = readTimestamp(entry, fallbackTimestamp);
      const toolMessages = parseClaudeToolUse(entry.message, timestamp, cwd || null);
      if (toolMessages.length > 0) {
        messages.push(...toolMessages);
      }

      const text = extractVisibleAssistantText(entry.message);
      if (text) {
        messages.push({
          role: "assistant",
          text,
          timestamp,
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
