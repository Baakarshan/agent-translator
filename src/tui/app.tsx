import path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { getTranslatorConfig } from "../config.js";
import { SessionIndex, selectSessionDescriptor } from "../session-discovery.js";
import { watchSessionSnapshot } from "../session-watch.js";
import { TranscriptTranslationStore } from "../translator/service.js";
import type { DisplayMessage, ProviderId, SessionDescriptor, SessionSnapshot } from "../types.js";

type AppProps = {
  provider?: ProviderId | undefined;
  latest?: boolean | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  afterMs?: number | undefined;
};

type ViewState = "list" | "detail" | "waiting";

type TranscriptLine = {
  key: string;
  prefix?: string;
  prefixColor?: string;
  text: string;
  color?: string;
  wrap?: "wrap" | "truncate-end";
  segments?: TranscriptSegment[] | undefined;
};

type TranscriptSegment = {
  text: string;
  color?: string | undefined;
  bold?: boolean | undefined;
  dimColor?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
};

const LABEL_COLUMN_WIDTH = 4;
const MESSAGE_GUTTER = "│";
const MESSAGE_CONTENT_PADDING = " ";

const THEME = {
  provider: {
    codex: "#7dd3fc",
    claude: "#fbbf24",
  },
  userLabel: "#7dd3fc",
  userText: "#e2e8f0",
  assistantLabel: "#f8fafc",
  assistantText: "#f5f5f4",
  summaryLabel: "#67e8f9",
  summaryText: "#e7e5e4",
  chrome: {
    title: "#f8fafc",
    meta: "#a8a29e",
    rule: "#57534e",
  },
  statusQueued: "#fbbf24",
  statusFailed: "#f87171",
  markdown: {
    heading1: "#f8fafc",
    heading2: "#93c5fd",
    heading3: "#c4b5fd",
    bullet: "#67e8f9",
    quoteBar: "#fbbf24",
    quoteText: "#d6d3d1",
    inlineCode: "#bfdbfe",
    codeFence: "#94a3b8",
    codeText: "#e2e8f0",
    codeKeyword: "#c4b5fd",
    codeString: "#86efac",
    codeComment: "#94a3b8",
    codeNumber: "#fca5a5",
    codePath: "#7dd3fc",
    codeFlag: "#fbbf24",
    link: "#7dd3fc",
    muted: "#a8a29e",
    rule: "#78716c",
    strong: "#ffffff",
    emphasis: "#d8b4fe",
  },
};

function getProviderColor(provider: ProviderId): string {
  return THEME.provider[provider];
}

function getAssistantLabel(message: DisplayMessage): { label: string; labelColor: string; textColor: string } {
  if (message.kind === "command") {
    return { label: "命令", labelColor: "#67e8f9", textColor: THEME.summaryText };
  }
  if (message.kind === "code") {
    return { label: "代码", labelColor: "#c4b5fd", textColor: THEME.summaryText };
  }
  if (message.kind === "diff") {
    return { label: "改动", labelColor: "#fda4af", textColor: THEME.summaryText };
  }
  if (message.kind === "shell") {
    return { label: "结果", labelColor: "#fbbf24", textColor: THEME.summaryText };
  }
  if (message.kind === "tool") {
    return { label: "工具", labelColor: "#5eead4", textColor: THEME.summaryText };
  }
  if (message.kind === "table") {
    return { label: "表格", labelColor: THEME.assistantLabel, textColor: THEME.assistantText };
  }
  return {
    label: "译文",
    labelColor: THEME.assistantLabel,
    textColor: THEME.assistantText,
  };
}

function getUserLabel(): { label: string; labelColor: string; textColor: string } {
  return {
    label: "用户",
    labelColor: THEME.userLabel,
    textColor: THEME.userText,
  };
}

function getShortTranslationError(message: DisplayMessage): string {
  const error = message.translationError?.trim();
  if (!error) {
    return "request failed";
  }
  return error.length > 60 ? `${error.slice(0, 57)}...` : error;
}

function buildMessagePrefix(label: string): string {
  const paddedLabel = `${label}${" ".repeat(Math.max(0, LABEL_COLUMN_WIDTH - textWidth(label)))}`;
  return `${paddedLabel} ${MESSAGE_GUTTER} ${MESSAGE_CONTENT_PADDING}`;
}

function buildContinuationPrefix(label: string): string {
  return " ".repeat(textWidth(buildMessagePrefix(label)));
}

function formatRelativeTime(lastActivityMs: number): string {
  const deltaMs = Math.max(0, Date.now() - lastActivityMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderLabeledLines(
  keyPrefix: string,
  label: string,
  text: string,
  labelColor: string,
  textColor: string,
): TranscriptLine[] {
  const logicalLines = text.split("\n");
  const prefix = buildMessagePrefix(label);
  const continuationPrefix = buildContinuationPrefix(label);
  const rendered: TranscriptLine[] = [];

  logicalLines.forEach((line, logicalIndex) => {
    const currentPrefix = logicalIndex === 0 ? prefix : continuationPrefix;
    rendered.push({
      key: `${keyPrefix}:${logicalIndex}`,
      prefix: currentPrefix,
      ...(logicalIndex === 0 ? { prefixColor: labelColor } : {}),
      text: line || " ",
      color: textColor,
      segments: [{ text: line || " ", color: textColor }],
      wrap: "wrap",
    });
  });

  return rendered;
}

function makeLine(
  key: string,
  prefix: string | undefined,
  prefixColor: string | undefined,
  segments: TranscriptSegment[],
  wrap: "wrap" | "truncate-end" = "wrap",
): TranscriptLine {
  return {
    key,
    ...(prefix ? { prefix } : {}),
    ...(prefixColor ? { prefixColor } : {}),
    text: segments.map((segment) => segment.text).join("") || " ",
    segments,
    wrap,
  };
}

function toPlainText(segments: TranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

type SegmentUnit = {
  text: string;
  width: number;
  color?: string | undefined;
  bold?: boolean | undefined;
  dimColor?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
};

function toSegmentUnits(segments: TranscriptSegment[]): SegmentUnit[] {
  const units: SegmentUnit[] = [];

  for (const segment of segments) {
    for (const char of segment.text) {
      units.push({
        text: char,
        width: textWidth(char),
        color: segment.color,
        bold: segment.bold,
        dimColor: segment.dimColor,
        italic: segment.italic,
        underline: segment.underline,
      });
    }
  }

  return units;
}

function coalesceUnits(units: SegmentUnit[]): TranscriptSegment[] {
  if (units.length === 0) {
    return [{ text: " " }];
  }

  const segments: TranscriptSegment[] = [];

  for (const unit of units) {
    const previous = segments[segments.length - 1];
    if (
      previous
      && previous.color === unit.color
      && previous.bold === unit.bold
      && previous.dimColor === unit.dimColor
      && previous.italic === unit.italic
      && previous.underline === unit.underline
    ) {
      previous.text += unit.text;
      continue;
    }

    segments.push({
      text: unit.text,
      color: unit.color,
      bold: unit.bold,
      dimColor: unit.dimColor,
      italic: unit.italic,
      underline: unit.underline,
    });
  }

  return segments;
}

function trimLeadingWhitespaceUnits(units: SegmentUnit[]): SegmentUnit[] {
  let index = 0;
  while (index < units.length && /^\s$/.test(units[index]?.text ?? "")) {
    index += 1;
  }
  return units.slice(index);
}

function wrapSegments(segments: TranscriptSegment[], maxWidth: number): TranscriptSegment[][] {
  const units = toSegmentUnits(segments);
  if (units.length === 0) {
    return [[{ text: " " }]];
  }

  const widthLimit = Math.max(1, maxWidth);
  const lines: TranscriptSegment[][] = [];
  let current: SegmentUnit[] = [];
  let currentWidth = 0;
  let lastWhitespaceIndex = -1;

  const pushCurrent = (lineUnits: SegmentUnit[]) => {
    lines.push(coalesceUnits(lineUnits));
  };

  const recalcWhitespace = () => {
    lastWhitespaceIndex = -1;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      if (/^\s$/.test(current[index]?.text ?? "")) {
        lastWhitespaceIndex = index;
        return;
      }
    }
  };

  for (const unit of units) {
    if (currentWidth + unit.width > widthLimit) {
      if (lastWhitespaceIndex >= 0) {
        const lineUnits = current.slice(0, lastWhitespaceIndex);
        const remaining = trimLeadingWhitespaceUnits(current.slice(lastWhitespaceIndex + 1));
        pushCurrent(lineUnits.length > 0 ? lineUnits : [{ ...unit, text: unit.text }]);
        current = remaining;
        currentWidth = current.reduce((sum, entry) => sum + entry.width, 0);
        recalcWhitespace();
      } else if (current.length > 0) {
        pushCurrent(current);
        current = [];
        currentWidth = 0;
        lastWhitespaceIndex = -1;
      }
    }

    current.push(unit);
    currentWidth += unit.width;
    if (/^\s$/.test(unit.text)) {
      lastWhitespaceIndex = current.length - 1;
    }
  }

  if (current.length > 0) {
    pushCurrent(current);
  }

  return lines.length > 0 ? lines : [[{ text: " " }]];
}

function wrapTranscriptLine(line: TranscriptLine, width: number): TranscriptLine[] {
  if (line.wrap === "truncate-end") {
    return [line];
  }

  const prefix = line.prefix ?? "";
  const continuationPrefix = " ".repeat(textWidth(prefix));
  const contentWidth = Math.max(1, width - textWidth(prefix));
  const sourceSegments = line.segments && line.segments.length > 0
    ? line.segments
    : [{ text: line.text || " ", ...(line.color ? { color: line.color } : {}) }];
  const wrappedSegments = wrapSegments(sourceSegments, contentWidth);

  return wrappedSegments.map((segments, index) => ({
    key: index === 0 ? line.key : `${line.key}:wrap:${index}`,
    ...((index === 0 ? line.prefix : continuationPrefix) ? { prefix: index === 0 ? line.prefix : continuationPrefix } : {}),
    ...(index === 0 && line.prefixColor ? { prefixColor: line.prefixColor } : {}),
    text: toPlainText(segments),
    segments,
    wrap: "truncate-end",
  }));
}

function codeTokenColor(token: string): string | null {
  if (!token) {
    return null;
  }

  if (/^(\/\/.*|#.*)$/.test(token.trim())) {
    return THEME.markdown.codeComment;
  }
  if (/^(['"`]).*\1$/.test(token)) {
    return THEME.markdown.codeString;
  }
  if (/^--?[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(token)) {
    return THEME.markdown.codeFlag;
  }
  if (/^(~|\/|\.\/|\.\.\/)[^\s]*$/.test(token) || /^[A-Za-z0-9._/-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return THEME.markdown.codePath;
  }
  if (/^(const|let|var|function|class|return|if|else|for|while|switch|case|break|continue|import|export|from|async|await|try|catch|throw|new|type|interface|extends|implements|public|private|protected|default)$/.test(token)) {
    return THEME.markdown.codeKeyword;
  }
  if (/^[0-9]+(\.[0-9]+)?$/.test(token)) {
    return THEME.markdown.codeNumber;
  }

  return null;
}

function renderCodeLineSegments(line: string): TranscriptSegment[] {
  if (!line) {
    return [{ text: " ", color: THEME.markdown.codeText }];
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return [{ text: line, color: THEME.markdown.codeComment, dimColor: true, italic: true }];
  }

  const tokenPattern = /(['"`](?:\\.|[^'"`])*['"`]|--?[A-Za-z0-9][A-Za-z0-9:_-]*|(?:~|\/|\.\/|\.\.\/)[^\s]+|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)/g;
  const segments: TranscriptSegment[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({
        text: line.slice(lastIndex, index),
        color: THEME.markdown.codeText,
      });
    }
    segments.push({
      text: token,
      color: codeTokenColor(token) ?? THEME.markdown.codeText,
      ...(codeTokenColor(token) === THEME.markdown.codeKeyword ? { bold: true } : {}),
    });
    lastIndex = index + token.length;
  }

  if (lastIndex < line.length) {
    segments.push({
      text: line.slice(lastIndex),
      color: THEME.markdown.codeText,
    });
  }

  return segments.length > 0 ? segments : [{ text: line, color: THEME.markdown.codeText }];
}

function textWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += codePoint > 0xff ? 2 : 1;
  }
  return width;
}

function truncateToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (textWidth(value) <= maxWidth) {
    return value;
  }

  const ellipsis = "…";
  const targetWidth = Math.max(1, maxWidth - textWidth(ellipsis));
  let result = "";
  let currentWidth = 0;

  for (const char of value) {
    const nextWidth = textWidth(char);
    if (currentWidth + nextWidth > targetWidth) {
      break;
    }
    result += char;
    currentWidth += nextWidth;
  }

  return `${result}${ellipsis}`;
}

function padCell(value: string, width: number): string {
  const currentWidth = textWidth(value);
  if (currentWidth >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - currentWidth)}`;
}

function renderInlineMarkdown(text: string, baseColor: string): TranscriptSegment[] {
  const tokenPattern = /(`[^`\n]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))/g;
  const segments: TranscriptSegment[] = [];
  let lastIndex = 0;

  const pushPlain = (value: string) => {
    if (!value) {
      return;
    }
    segments.push({ text: value, color: baseColor });
  };

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    pushPlain(text.slice(lastIndex, index));

    if (token.startsWith("`") && token.endsWith("`")) {
      segments.push({
        text: token.slice(1, -1),
        color: THEME.markdown.inlineCode,
        bold: true,
      });
    } else if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
      const nested = renderInlineMarkdown(token.slice(2, -2), THEME.markdown.strong).map((segment) => ({
        ...segment,
        color: segment.color === baseColor ? THEME.markdown.strong : segment.color,
        bold: true,
      }));
      segments.push(...nested);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      segments.push({
        text: token.slice(2, -2),
        color: THEME.markdown.muted,
        dimColor: true,
      });
    } else if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
      const nested = renderInlineMarkdown(token.slice(1, -1), THEME.markdown.emphasis).map((segment) => ({
        ...segment,
        color: segment.color === baseColor ? THEME.markdown.emphasis : segment.color,
        italic: true,
      }));
      segments.push(...nested);
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        segments.push(...renderInlineMarkdown(linkMatch[1] ?? "", THEME.markdown.link).map((segment) => ({
          ...segment,
          color: THEME.markdown.link,
          underline: true,
        })));
        segments.push({
          text: ` (${linkMatch[2] ?? ""})`,
          color: THEME.markdown.muted,
          dimColor: true,
        });
      } else {
        pushPlain(token);
      }
    } else {
      pushPlain(token);
    }

    lastIndex = index + token.length;
  }

  pushPlain(text.slice(lastIndex));
  return segments.length > 0 ? segments : [{ text, color: baseColor }];
}

function stripInlineMarkdown(text: string): string {
  return toPlainText(renderInlineMarkdown(text, THEME.assistantText));
}

function renderMarkdownLines(
  keyPrefix: string,
  label: string,
  text: string,
  labelColor: string,
  textColor: string,
  width: number,
): TranscriptLine[] {
  const prefix = buildMessagePrefix(label);
  const continuationPrefix = buildContinuationPrefix(label);
  const logicalLines = text.replace(/\r\n/g, "\n").split("\n");
  const rendered: TranscriptLine[] = [];
  const contentWidth = Math.max(12, width - textWidth(prefix));
  let inCodeBlock = false;
  let codeLanguage = "";
  let firstVisibleLine = true;

  const nextPrefix = (): { prefix: string; prefixColor?: string } => {
    if (firstVisibleLine) {
      firstVisibleLine = false;
      return { prefix, prefixColor: labelColor };
    }
    return { prefix: continuationPrefix };
  };

  for (let index = 0; index < logicalLines.length; index += 1) {
    const rawLine = logicalLines[index] ?? "";
    const trimmed = rawLine.trim();
    const { prefix: linePrefix, prefixColor } = nextPrefix();

    const fenceMatch = trimmed.match(/^```([^\n`]*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = (fenceMatch[1] ?? "").trim();
        const title = codeLanguage ? `┌─ ${codeLanguage}` : "┌─ code";
      rendered.push(makeLine(
          `${keyPrefix}:${index}:code-open`,
          linePrefix,
          prefixColor,
          [{ text: title, color: THEME.markdown.codeFence, bold: true }],
        ));
      } else {
        inCodeBlock = false;
        codeLanguage = "";
        rendered.push(makeLine(
          `${keyPrefix}:${index}:code-close`,
          linePrefix,
          prefixColor,
          [{ text: "└", color: THEME.markdown.codeFence, bold: true }],
        ));
      }
      continue;
    }

    if (inCodeBlock) {
      rendered.push(makeLine(
        `${keyPrefix}:${index}:code`,
        linePrefix,
        prefixColor,
        [
          { text: "│ ", color: THEME.markdown.codeFence },
          ...renderCodeLineSegments(rawLine || " "),
        ],
      ));
      continue;
    }

    if (!trimmed) {
      rendered.push(makeLine(
        `${keyPrefix}:${index}:blank`,
        linePrefix,
        prefixColor,
        [{ text: " ", color: textColor }],
      ));
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      rendered.push(makeLine(
        `${keyPrefix}:${index}:rule`,
        linePrefix,
        prefixColor,
        [{ text: "─".repeat(contentWidth), color: THEME.markdown.rule, dimColor: true }],
        "truncate-end",
      ));
      continue;
    }

    const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const headingColor = level === 1
        ? THEME.markdown.heading1
        : level === 2
          ? THEME.markdown.heading2
          : THEME.markdown.heading3;
      rendered.push(makeLine(
        `${keyPrefix}:${index}:heading`,
        linePrefix,
        prefixColor,
        renderInlineMarkdown(headingMatch[2] ?? "", headingColor).map((segment) => ({
          ...segment,
          color: headingColor,
          bold: true,
        })),
      ));
      continue;
    }

    const quoteMatch = rawLine.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      rendered.push(makeLine(
        `${keyPrefix}:${index}:quote`,
        linePrefix,
        prefixColor,
        [
          { text: "▎ ", color: THEME.markdown.quoteBar, bold: true },
          ...renderInlineMarkdown(quoteMatch[1] ?? "", THEME.markdown.quoteText),
        ],
      ));
      continue;
    }

    const unorderedMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      const indent = " ".repeat(unorderedMatch[1]?.length ?? 0);
      rendered.push(makeLine(
        `${keyPrefix}:${index}:bullet`,
        linePrefix,
        prefixColor,
        [
          { text: indent, color: textColor },
          { text: "• ", color: THEME.markdown.bullet, bold: true },
          ...renderInlineMarkdown(unorderedMatch[2] ?? "", textColor),
        ],
      ));
      continue;
    }

    const orderedMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      const indent = " ".repeat(orderedMatch[1]?.length ?? 0);
      rendered.push(makeLine(
        `${keyPrefix}:${index}:ordered`,
        linePrefix,
        prefixColor,
        [
          { text: indent, color: textColor },
          { text: `${orderedMatch[2]}. `, color: THEME.markdown.bullet, bold: true },
          ...renderInlineMarkdown(orderedMatch[3] ?? "", textColor),
        ],
      ));
      continue;
    }

    rendered.push(makeLine(
      `${keyPrefix}:${index}:text`,
      linePrefix,
      prefixColor,
      renderInlineMarkdown(rawLine, textColor),
    ));
  }

  return rendered;
}

function parseMarkdownTable(text: string): string[][] | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return null;
  }

  const separator = lines[1] ?? "";
  if (!/^\|?[:\-\s|]+\|?$/.test(separator)) {
    return null;
  }

  const rows = lines
    .filter((_, index) => index !== 1)
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount === 0 || rows.some((row) => row.length !== columnCount)) {
    return null;
  }

  return rows;
}

function fitColumnWidths(rows: string[][], maxWidth: number): number[] {
  const columnCount = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...rows.map((row) => textWidth(row[index] ?? ""))),
  );
  const minColumnWidth = 4;
  const borderWidth = 3 * columnCount + 1;
  const maxContentWidth = Math.max(columnCount * minColumnWidth, maxWidth - borderWidth);
  let totalWidth = widths.reduce((sum, width) => sum + width, 0);

  if (totalWidth <= maxContentWidth) {
    return widths;
  }

  const nextWidths = widths.map((width) => Math.max(minColumnWidth, width));
  totalWidth = nextWidths.reduce((sum, width) => sum + width, 0);

  while (totalWidth > maxContentWidth) {
    let shrunk = false;
    for (let index = 0; index < nextWidths.length && totalWidth > maxContentWidth; index += 1) {
      const currentWidth = nextWidths[index];
      if (typeof currentWidth === "number" && currentWidth > minColumnWidth) {
        nextWidths[index] = currentWidth - 1;
        totalWidth -= 1;
        shrunk = true;
      }
    }
    if (!shrunk) {
      break;
    }
  }

  return nextWidths;
}

function renderTableLines(
  keyPrefix: string,
  label: string,
  labelColor: string,
  textColor: string,
  tableText: string,
  width: number,
): TranscriptLine[] | null {
  const rows = parseMarkdownTable(tableText);
  if (!rows) {
    return null;
  }
  const normalizedRows = rows.map((row) => row.map((cell) => stripInlineMarkdown(cell)));

  const prefix = buildMessagePrefix(label);
  const continuationPrefix = buildContinuationPrefix(label);
  // Keep a safety margin so box-drawing tables do not hit the terminal edge and wrap.
  const availableWidth = Math.max(20, width - textWidth(prefix) - 6);
  const columnWidths = fitColumnWidths(normalizedRows, availableWidth);
  const border = (left: string, middle: string, right: string): string =>
    `${left}${columnWidths.map((cellWidth) => "─".repeat(cellWidth + 2)).join(middle)}${right}`;
  const makeRow = (row: string[]): string =>
    `│ ${row.map((cell, index) => padCell(truncateToWidth(cell, columnWidths[index]!), columnWidths[index]!)).join(" │ ")} │`;

  const tableLines = [
    border("┌", "┬", "┐"),
    makeRow(normalizedRows[0]!),
    border("├", "┼", "┤"),
    ...normalizedRows.slice(1).map(makeRow),
    border("└", "┴", "┘"),
  ];

  return tableLines.map((line, index) => ({
    key: `${keyPrefix}:${index}`,
    prefix: index === 0 ? prefix : continuationPrefix,
    ...(index === 0 ? { prefixColor: labelColor } : {}),
    text: line,
    color: textColor,
    segments: [{ text: line, color: textColor }],
    wrap: "truncate-end",
  }));
}

export function flattenTranscript(messages: DisplayMessage[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const rendered = getUserLabel();
      lines.push(
        ...renderMarkdownLines(
          `${message.messageId}:original`,
          rendered.label,
          message.originalText,
          rendered.labelColor,
          rendered.textColor,
          width,
        ),
      );
      lines.push({
        key: `${message.messageId}:separator`,
        text: "",
        segments: [{ text: "" }],
      });
      continue;
    }

    if (message.displayText) {
      const rendered = getAssistantLabel(message);
      const renderedTable = message.kind === "table"
        ? renderTableLines(
            `${message.messageId}:display-table`,
            rendered.label,
            rendered.labelColor,
            rendered.textColor,
            message.displayText,
            width,
          )
        : null;
      lines.push(
        ...(renderedTable ?? renderMarkdownLines(
          `${message.messageId}:display`,
          rendered.label,
          message.displayText,
          rendered.labelColor,
          rendered.textColor,
          width,
        )),
      );
    } else if (message.translationStatus === "scheduled") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: buildMessagePrefix("状态"),
        prefixColor: THEME.statusQueued,
        text: "[等待生成]",
        color: THEME.statusQueued,
        segments: [{ text: "[等待生成]", color: THEME.statusQueued, bold: true }],
        wrap: "wrap",
      });
    } else if (message.translationStatus === "translating") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: buildMessagePrefix("状态"),
        prefixColor: THEME.statusQueued,
        text: "[生成中]",
        color: THEME.statusQueued,
        segments: [{ text: "[生成中]", color: THEME.statusQueued, bold: true }],
        wrap: "wrap",
      });
    } else if (message.translationStatus === "failed") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: buildMessagePrefix("状态"),
        prefixColor: THEME.statusFailed,
        text: `[失败: ${getShortTranslationError(message)}]`,
        color: THEME.statusFailed,
        segments: [{ text: `[失败: ${getShortTranslationError(message)}]`, color: THEME.statusFailed, bold: true }],
        wrap: "wrap",
      });
    }

    lines.push({
      key: `${message.messageId}:separator`,
      text: "",
      segments: [{ text: "" }],
    });
  }

  return lines.flatMap((line) => wrapTranscriptLine(line, width));
}

export function getTranscriptRenderKey(messages: DisplayMessage[], width: number): string {
  return flattenTranscript(messages, width)
    .map((line) => [
      line.key,
      line.prefix ?? "",
      line.text,
      line.color ?? "",
      line.prefixColor ?? "",
      line.wrap ?? "",
      (line.segments ?? []).map((segment) => [
        segment.text,
        segment.color ?? "",
        segment.bold ? "1" : "0",
        segment.dimColor ? "1" : "0",
        segment.italic ? "1" : "0",
        segment.underline ? "1" : "0",
      ].join("\u0002")).join("\u0003"),
    ].join("\u0000"))
    .join("\u0001");
}

export function getDescriptorWatchKey(descriptor: SessionDescriptor | null): string | null {
  if (!descriptor) {
    return null;
  }
  return `${descriptor.provider}:${descriptor.sessionId}:${descriptor.filePath}`;
}

export function resolveSelectedDescriptor(params: {
  sessions: SessionDescriptor[];
  provider?: ProviderId | undefined;
  latest?: boolean | undefined;
  sessionId?: string | null | undefined;
  cwd?: string | undefined;
  afterMs?: number | undefined;
  selectedIndex: number;
}): SessionDescriptor | null {
  const visibleSessions = params.provider
    ? params.sessions.filter((session) => session.provider === params.provider)
    : params.sessions;

  if (params.sessionId) {
    const targetCwd = params.cwd ? path.resolve(params.cwd) : null;
    return (
      params.sessions.find(
        (session) =>
          session.sessionId === params.sessionId &&
          (!params.provider || session.provider === params.provider) &&
          (!targetCwd || path.resolve(session.cwd) === targetCwd),
      ) ?? null
    );
  }

  if (params.latest) {
    return selectSessionDescriptor(params.sessions, {
      provider: params.provider,
      latest: true,
      cwd: params.cwd,
      afterMs: params.afterMs,
    });
  }

  return visibleSessions[params.selectedIndex] ?? null;
}

function SessionListView(props: { sessions: SessionDescriptor[]; selectedIndex: number }): React.JSX.Element {
  if (props.sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">还没有匹配的会话。</Text>
        <Text dimColor>先启动 `codex` 或 `claude`，或直接使用带 `--tui` 的包装命令。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {props.sessions.map((session, index) => {
        const selected = index === props.selectedIndex;
        return (
          <Box key={session.filePath} flexDirection="column" marginBottom={index === props.sessions.length - 1 ? 0 : 1}>
            <Text wrap="truncate-end" {...(selected ? { inverse: true } : {})}>
              <Text color={getProviderColor(session.provider)}>{selected ? "› " : "  "}</Text>
              <Text color={getProviderColor(session.provider)} bold>
                [{session.provider.toUpperCase()}]
              </Text>
              <Text color={THEME.chrome.title}> {session.title}</Text>
            </Text>
            <Text dimColor>
              {"   "}
              {session.sessionId.slice(0, 8)} · {path.basename(session.cwd)} · {formatRelativeTime(session.lastActivityMs)} ·{" "}
              <Text color={session.live ? "#67e8f9" : THEME.chrome.meta}>{session.live ? "进行中" : "空闲"}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

const SessionDetailView = React.memo(function SessionDetailView(props: {
  descriptor: SessionDescriptor;
  snapshot: SessionSnapshot | null;
  messages: DisplayMessage[];
}): React.JSX.Element {
  const transcriptWidth = (process.stdout.columns ?? 100) - 4;
  const transcriptLines = flattenTranscript(props.messages, transcriptWidth);
  const prefixWidth = transcriptLines.reduce((max, line) => Math.max(max, textWidth(line.prefix ?? "")), 0);
  const bodyWidth = Math.max(12, transcriptWidth - prefixWidth);

  return (
    <Box flexDirection="column">
      <Text color={THEME.chrome.rule}>╭──────────────────────────────────────────────────────────────────────────────╮</Text>
      <Text>
        <Text color={THEME.chrome.rule}>│ </Text>
        <Text color={THEME.chrome.title} bold>{props.descriptor.title}</Text>
      </Text>
      <Text>
        <Text color={THEME.chrome.rule}>│ </Text>
        <Text color={getProviderColor(props.descriptor.provider)} bold>
          [{props.descriptor.provider.toUpperCase()}]
        </Text>
        <Text color={THEME.chrome.meta}>  {props.descriptor.sessionId.slice(0, 8)} · {path.basename(props.descriptor.cwd)}</Text>
      </Text>
      <Text>
        <Text color={THEME.chrome.rule}>│ </Text>
        <Text color={THEME.chrome.meta}>{props.descriptor.cwd}</Text>
      </Text>
      <Text>
        <Text color={THEME.chrome.rule}>╰─ </Text>
        <Text color={THEME.chrome.meta}>
          {props.snapshot ? `${props.snapshot.messages.length} 条消息` : "正在加载会话..."} · 原生滚动 · q 退出 · b 返回
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {transcriptLines.map((line) => (
          <Box key={line.key} flexDirection="column">
            {line.prefix && line.prefix.trim() ? (
              <Box flexDirection="row">
                <Box width={prefixWidth}>
                  <Text {...(line.prefixColor ? { color: line.prefixColor } : {})}>{line.prefix}</Text>
                </Box>
                <Box width={bodyWidth}>
                  <Text> </Text>
                </Box>
              </Box>
            ) : null}
            <Box flexDirection="row">
              <Box width={prefixWidth}>
                <Text>{line.prefix && line.prefix.trim() ? " ".repeat(prefixWidth) : (line.prefix ?? "")}</Text>
              </Box>
              <Box width={bodyWidth}>
                <Text wrap={line.wrap ?? "wrap"}>
                  {line.segments && line.segments.length > 0 ? (
                    <>
                      {line.segments.map((segment, index) => (
                        <Text
                          key={`${line.key}:${index}`}
                          {...(segment.color ? { color: segment.color } : {})}
                          {...(segment.bold ? { bold: true } : {})}
                          {...(segment.dimColor ? { dimColor: true } : {})}
                          {...(segment.italic ? { italic: true } : {})}
                          {...(segment.underline ? { underline: true } : {})}
                        >
                          {segment.text || " "}
                        </Text>
                      ))}
                    </>
                  ) : (
                    <Text {...(line.color ? { color: line.color } : {})}>{line.text || " "}</Text>
                  )}
                </Text>
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
});

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [view, setView] = useState<ViewState>(props.latest || props.sessionId ? "waiting" : "list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(props.sessionId ?? null);
  const [attachedDescriptor, setAttachedDescriptor] = useState<SessionDescriptor | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const transcriptRenderKeyRef = useRef<string>("");

  const visibleSessions = useMemo(() => {
    if (!props.provider) {
      return sessions;
    }
    return sessions.filter((session) => session.provider === props.provider);
  }, [props.provider, sessions]);

  const selectedDescriptor = useMemo(() => {
    return resolveSelectedDescriptor({
      sessions,
      provider: props.provider,
      latest: props.latest,
      sessionId: selectedSessionId,
      cwd: props.cwd,
      afterMs: props.afterMs,
      selectedIndex,
    });
  }, [props.afterMs, props.cwd, props.latest, props.provider, selectedIndex, selectedSessionId, sessions]);
  const selectedDescriptorWatchKey = getDescriptorWatchKey(selectedDescriptor);
  const detailDescriptor = attachedDescriptor ?? selectedDescriptor;

  useEffect(() => {
    if (selectedDescriptor) {
      setAttachedDescriptor(selectedDescriptor);
      return;
    }
    setAttachedDescriptor(null);
  }, [selectedDescriptorWatchKey]);

  useEffect(() => {
    const index = new SessionIndex(props.provider);
    const onUpdate = (nextSessions: SessionDescriptor[]) => {
      setSessions(nextSessions);
    };

    index.on("update", onUpdate);
    void index.start();

    return () => {
      index.off("update", onUpdate);
      void index.stop();
    };
  }, [props.provider]);

  useEffect(() => {
    if ((props.latest || props.sessionId) && selectedDescriptor) {
      setSelectedSessionId(selectedDescriptor.sessionId);
      setView("detail");
    } else if ((props.latest || props.sessionId) && !selectedDescriptor) {
      setView("waiting");
    }
  }, [props.latest, props.sessionId, selectedDescriptorWatchKey]);

  useEffect(() => {
    if (selectedIndex >= visibleSessions.length) {
      setSelectedIndex(Math.max(0, visibleSessions.length - 1));
    }
  }, [selectedIndex, visibleSessions.length]);

  useEffect(() => {
    transcriptRenderKeyRef.current = "";
  }, [selectedDescriptorWatchKey]);

  useEffect(() => {
    if (!selectedDescriptor) {
      setSnapshot(null);
      setMessages([]);
      return;
    }

    let active = true;
    const store = new TranscriptTranslationStore({
      config: getTranslatorConfig(),
    });
    const updateMessages = (nextMessages: DisplayMessage[]) => {
      if (!active) {
        return;
      }
      const nextRenderKey = getTranscriptRenderKey(nextMessages, (process.stdout.columns ?? 100) - 4);
      if (transcriptRenderKeyRef.current === nextRenderKey) {
        return;
      }
      transcriptRenderKeyRef.current = nextRenderKey;
      setMessages(nextMessages);
    };
    store.on("update", updateMessages);

    const stopWatching = watchSessionSnapshot(selectedDescriptor, (nextSnapshot) => {
      if (!active) {
        return;
      }
      setSnapshot(nextSnapshot);
      if (nextSnapshot) {
        void store.setMessages(nextSnapshot.messages);
      } else {
        void store.setMessages([]);
      }
    });

    return () => {
      active = false;
      store.off("update", updateMessages);
      store.destroy();
      void stopWatching();
    };
  }, [selectedDescriptorWatchKey]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (view === "list") {
      if (key.upArrow || input === "k") {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((current) => Math.min(visibleSessions.length - 1, current + 1));
        return;
      }
      if (key.return) {
        const next = visibleSessions[selectedIndex];
        if (next) {
          setSelectedSessionId(next.sessionId);
          setView("detail");
        }
      }
      return;
    }

    if (input === "b") {
      setView("list");
      setSelectedSessionId(null);
    }
  });

  if (view === "waiting") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">正在等待匹配的会话…</Text>
        <Text dimColor>
          {props.provider ? `provider=${props.provider}` : "provider=any"}{" "}
          {props.sessionId ? `session=${props.sessionId}` : "latest=true"}
        </Text>
        {props.cwd ? <Text dimColor>cwd={props.cwd}</Text> : null}
        <Text dimColor>ctrl+c/q 退出 · b 返回列表</Text>
      </Box>
    );
  }

  if (view === "detail" && detailDescriptor) {
    return (
      <SessionDetailView
        descriptor={detailDescriptor}
        snapshot={snapshot}
        messages={messages}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={THEME.chrome.rule}>╭──────────────────────────────────────────────────────────────────────────────╮</Text>
      <Text>
        <Text color={THEME.chrome.rule}>│ </Text>
        <Text color={THEME.chrome.title} bold>Agent Translator</Text>
      </Text>
      <Text>
        <Text color={THEME.chrome.rule}>│ </Text>
        <Text color={THEME.chrome.meta}>方向键选择 · Enter 进入 · q 退出</Text>
      </Text>
      <Text>
        <Text color={THEME.chrome.rule}>╰─ </Text>
        <Text color={THEME.chrome.meta}>
          {props.provider ? `filter=${props.provider}` : "filter=all"}
          {props.cwd ? ` · cwd=${props.cwd}` : ""}
          {" · "}
          {visibleSessions.length} 个会话
        </Text>
      </Text>
      <Box marginTop={1}>
        <SessionListView sessions={visibleSessions} selectedIndex={selectedIndex} />
      </Box>
    </Box>
  );
}
