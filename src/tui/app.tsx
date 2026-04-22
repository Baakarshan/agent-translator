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
};

const LABEL_COLUMN_WIDTH = 4;

const THEME = {
  provider: {
    codex: "#60a5fa",
    claude: "#f59e0b",
  },
  userLabel: "#60a5fa",
  userText: "#dbeafe",
  assistantLabel: "#f59e0b",
  assistantText: "#f5f5f4",
  summaryLabel: "#fb923c",
  summaryText: "#e7e5e4",
  statusQueued: "#fbbf24",
  statusFailed: "#f87171",
};

function getProviderColor(provider: ProviderId): string {
  return THEME.provider[provider];
}

function getAssistantLabel(message: DisplayMessage): { label: string; labelColor: string; textColor: string } {
  if (message.kind === "command") {
    return { label: "命令", labelColor: THEME.summaryLabel, textColor: THEME.summaryText };
  }
  if (message.kind === "code") {
    return { label: "代码", labelColor: THEME.summaryLabel, textColor: THEME.summaryText };
  }
  if (message.kind === "diff") {
    return { label: "改动", labelColor: THEME.summaryLabel, textColor: THEME.summaryText };
  }
  if (message.kind === "shell") {
    return { label: "输出", labelColor: THEME.summaryLabel, textColor: THEME.summaryText };
  }
  if (message.kind === "tool") {
    return { label: "工具", labelColor: THEME.summaryLabel, textColor: THEME.summaryText };
  }
  if (message.kind === "table") {
    return { label: "表格", labelColor: THEME.assistantLabel, textColor: THEME.assistantText };
  }
  return {
    label: "翻译",
    labelColor: THEME.assistantLabel,
    textColor: THEME.assistantText,
  };
}

function getShortTranslationError(message: DisplayMessage): string {
  const error = message.translationError?.trim();
  if (!error) {
    return "request failed";
  }
  return error.length > 60 ? `${error.slice(0, 57)}...` : error;
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
  const paddedLabel = `${label}${" ".repeat(Math.max(0, LABEL_COLUMN_WIDTH - textWidth(label)))}`;
  const prefix = `${paddedLabel} `;
  const continuationPrefix = " ".repeat(textWidth(prefix));
  const rendered: TranscriptLine[] = [];

  logicalLines.forEach((line, logicalIndex) => {
    const currentPrefix = logicalIndex === 0 ? prefix : continuationPrefix;
    rendered.push({
      key: `${keyPrefix}:${logicalIndex}`,
      prefix: currentPrefix,
      ...(logicalIndex === 0 ? { prefixColor: labelColor } : {}),
      text: line || " ",
      color: textColor,
      wrap: "wrap",
    });
  });

  return rendered;
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

  const paddedLabel = `${label}${" ".repeat(Math.max(0, LABEL_COLUMN_WIDTH - textWidth(label)))}`;
  const prefix = `${paddedLabel} `;
  const continuationPrefix = " ".repeat(textWidth(prefix));
  const availableWidth = Math.max(24, width - textWidth(prefix));
  const columnWidths = fitColumnWidths(rows, availableWidth);
  const border = (left: string, middle: string, right: string): string =>
    `${left}${columnWidths.map((cellWidth) => "─".repeat(cellWidth + 2)).join(middle)}${right}`;
  const makeRow = (row: string[]): string =>
    `│ ${row.map((cell, index) => padCell(truncateToWidth(cell, columnWidths[index]!), columnWidths[index]!)).join(" │ ")} │`;

  const tableLines = [
    border("┌", "┬", "┐"),
    makeRow(rows[0]!),
    border("├", "┼", "┤"),
    ...rows.slice(1).map(makeRow),
    border("└", "┴", "┘"),
  ];

  return tableLines.map((line, index) => ({
    key: `${keyPrefix}:${index}`,
    prefix: index === 0 ? prefix : continuationPrefix,
    ...(index === 0 ? { prefixColor: labelColor } : {}),
    text: line,
    color: textColor,
    wrap: "truncate-end",
  }));
}

export function flattenTranscript(messages: DisplayMessage[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      lines.push(
        ...renderLabeledLines(
          `${message.messageId}:original`,
          "你",
          message.originalText,
          THEME.userLabel,
          THEME.userText,
        ),
      );
      lines.push({
        key: `${message.messageId}:separator`,
        text: "",
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
        ...(renderedTable ?? renderLabeledLines(
          `${message.messageId}:display`,
          rendered.label,
          message.displayText,
          rendered.labelColor,
          rendered.textColor,
        )),
      );
    } else if (message.translationStatus === "scheduled") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: "状态 ",
        prefixColor: THEME.statusQueued,
        text: "[等待生成]",
        color: THEME.statusQueued,
        wrap: "wrap",
      });
    } else if (message.translationStatus === "translating") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: "状态 ",
        prefixColor: THEME.statusQueued,
        text: "[生成中]",
        color: THEME.statusQueued,
        wrap: "wrap",
      });
    } else if (message.translationStatus === "failed") {
      lines.push({
        key: `${message.messageId}:status`,
        prefix: "状态 ",
        prefixColor: THEME.statusFailed,
        text: `[失败: ${getShortTranslationError(message)}]`,
        color: THEME.statusFailed,
        wrap: "wrap",
      });
    }

    lines.push({
      key: `${message.messageId}:separator`,
      text: "",
    });
  }

  return lines;
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
        const live = session.live ? "进行中" : "空闲";
        const line = `${selected ? "›" : " "} [${session.provider}] ${session.title} (${session.sessionId.slice(-8)}) · ${formatRelativeTime(session.lastActivityMs)} · ${live}`;
        return (
          <Text
            key={session.filePath}
            color={getProviderColor(session.provider)}
            wrap="truncate-end"
            {...(selected ? { inverse: true } : {})}
          >
            {line}
          </Text>
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
  const transcriptLines = flattenTranscript(props.messages, (process.stdout.columns ?? 100) - 4);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={getProviderColor(props.descriptor.provider)}>[{props.descriptor.provider}]</Text>{" "}
        {props.descriptor.title}
      </Text>
      <Text dimColor>
        {props.descriptor.sessionId} · {props.descriptor.cwd}
      </Text>
      <Text dimColor>ctrl+c/q 退出 · b 返回列表 · 使用终端原生滚动浏览</Text>
      <Text dimColor>仅在 transcript 真正有新内容显示时才刷新</Text>
      <Text dimColor>
        {props.snapshot ? `${props.snapshot.messages.length} 条消息` : "正在加载会话..."}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {transcriptLines.map((line) => (
          <Text key={line.key} wrap={line.wrap ?? "wrap"}>
            {line.prefix ? (
              <Text {...(line.prefixColor ? { color: line.prefixColor } : {})}>{line.prefix}</Text>
            ) : null}
            <Text {...(line.color ? { color: line.color } : {})}>{line.text || " "}</Text>
          </Text>
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
      <Text>Agent Translator TUI</Text>
      <Text dimColor>ctrl+c/q 退出 · 方向键选择 · Enter 进入</Text>
      <Text dimColor>
        {props.provider ? `filter=${props.provider}` : "filter=all"}
        {props.cwd ? ` · cwd=${props.cwd}` : ""}
        {" · "}
        {visibleSessions.length} 个会话
      </Text>
      <Box marginTop={1}>
        <SessionListView sessions={visibleSessions} selectedIndex={selectedIndex} />
      </Box>
    </Box>
  );
}
