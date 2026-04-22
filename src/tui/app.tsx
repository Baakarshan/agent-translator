import React, { useEffect, useMemo, useState } from "react";
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
};

type ViewState = "list" | "detail" | "waiting";

type TranscriptLine = {
  key: string;
  text: string;
  color?: string;
};

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

function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) {
    return [text];
  }

  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    lines.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines;
}

function renderLabeledLines(
  keyPrefix: string,
  label: string,
  text: string,
  color: string,
  width: number,
): TranscriptLine[] {
  const logicalLines = text.split("\n");
  const prefix = `${label} `;
  const continuationPrefix = " ".repeat(prefix.length);
  const availableWidth = Math.max(20, width - prefix.length);
  const rendered: TranscriptLine[] = [];

  logicalLines.forEach((line, logicalIndex) => {
    const wrapped = wrapLine(line || " ", availableWidth);
    wrapped.forEach((chunk, wrappedIndex) => {
      const currentPrefix = logicalIndex === 0 && wrappedIndex === 0 ? prefix : continuationPrefix;
      rendered.push({
        key: `${keyPrefix}:${logicalIndex}:${wrappedIndex}`,
        text: `${currentPrefix}${chunk}`,
        color,
      });
    });
  });

  return rendered;
}

export function flattenTranscript(messages: DisplayMessage[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (const message of messages) {
    const englishLabel = message.role === "user" ? "You>" : "AI >";
    const englishColor = message.role === "user" ? "cyan" : "white";
    lines.push(
      ...renderLabeledLines(
        `${message.messageId}:original`,
        englishLabel,
        message.originalText,
        englishColor,
        width,
      ),
    );

    if (message.role === "assistant") {
      if (message.translatedText) {
        lines.push(
          ...renderLabeledLines(
            `${message.messageId}:translated`,
            "ZH >",
            message.translatedText,
            "green",
            width,
          ),
        );
      } else if (message.translationStatus === "scheduled" || message.translationStatus === "translating") {
        lines.push({
          key: `${message.messageId}:status`,
          text: "ZH > [translating...]",
          color: "yellow",
        });
      } else if (message.translationStatus === "failed") {
        lines.push({
          key: `${message.messageId}:status`,
          text: `ZH > [translation failed: ${message.translationError ?? "unknown error"}]`,
          color: "red",
        });
      }
    }

    lines.push({
      key: `${message.messageId}:separator`,
      text: "",
    });
  }

  return lines;
}

function SessionListView(props: { sessions: SessionDescriptor[]; selectedIndex: number }): React.JSX.Element {
  if (props.sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No matching sessions found yet.</Text>
        <Text dimColor>Start `codex` or `claude`, or use the wrapper commands with `--tui`.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {props.sessions.map((session, index) => {
        const selected = index === props.selectedIndex;
        const marker = selected ? ">" : " ";
        const live = session.live ? "live" : "idle";
        const line = [
          marker,
          `[${session.provider}]`,
          session.title,
          `(${session.sessionId.slice(-8)})`,
          `· ${formatRelativeTime(session.lastActivityMs)}`,
          `· ${live}`,
        ].join(" ");
        return (
          <Text key={session.filePath} inverse={selected}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

function SessionDetailView(props: {
  descriptor: SessionDescriptor;
  snapshot: SessionSnapshot | null;
  messages: DisplayMessage[];
  scrollOffset: number;
  visibleHeight: number;
}): React.JSX.Element {
  const transcriptLines = flattenTranscript(props.messages, (process.stdout.columns ?? 100) - 4);
  const maxOffset = Math.max(0, transcriptLines.length - props.visibleHeight);
  const start = Math.min(props.scrollOffset, maxOffset);
  const visibleLines = transcriptLines.slice(start, start + props.visibleHeight);

  return (
    <Box flexDirection="column">
      <Text>
        [{props.descriptor.provider}] {props.descriptor.title}
      </Text>
      <Text dimColor>
        {props.descriptor.sessionId} · {props.descriptor.cwd}
      </Text>
      <Text dimColor>q quit · b back · j/k or arrows scroll</Text>
      <Text dimColor>
        {props.snapshot ? `${props.snapshot.messages.length} messages` : "Loading transcript..."}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.map((line) => (
          <Text key={line.key} {...(line.color ? { color: line.color } : {})}>
            {line.text || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [view, setView] = useState<ViewState>(props.latest || props.sessionId ? "waiting" : "list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(props.sessionId ?? null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [followTail, setFollowTail] = useState(true);

  const visibleSessions = useMemo(() => {
    if (!props.provider) {
      return sessions;
    }
    return sessions.filter((session) => session.provider === props.provider);
  }, [props.provider, sessions]);

  const selectedDescriptor = useMemo(() => {
    if (props.latest) {
      return selectSessionDescriptor(sessions, {
        provider: props.provider,
        latest: true,
        cwd: props.cwd,
      });
    }

    if (selectedSessionId) {
      return (
        sessions.find(
          (session) =>
            session.sessionId === selectedSessionId &&
            (!props.provider || session.provider === props.provider) &&
            (!props.cwd || session.cwd === props.cwd),
        ) ?? null
      );
    }

    return visibleSessions[selectedIndex] ?? null;
  }, [props.cwd, props.latest, props.provider, selectedIndex, selectedSessionId, sessions, visibleSessions]);

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
  }, [props.latest, props.sessionId, selectedDescriptor]);

  useEffect(() => {
    if (selectedIndex >= visibleSessions.length) {
      setSelectedIndex(Math.max(0, visibleSessions.length - 1));
    }
  }, [selectedIndex, visibleSessions.length]);

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
  }, [selectedDescriptor]);

  const transcriptLines = useMemo(
    () => flattenTranscript(messages, (process.stdout.columns ?? 100) - 4),
    [messages],
  );
  const visibleHeight = Math.max(8, (process.stdout.rows ?? 24) - 8);
  const maxScrollOffset = Math.max(0, transcriptLines.length - visibleHeight);

  useEffect(() => {
    if (followTail) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    setScrollOffset((current) => Math.min(current, maxScrollOffset));
  }, [followTail, maxScrollOffset]);

  useInput((input, key) => {
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
          setFollowTail(true);
        }
      }
      return;
    }

    if (input === "b") {
      setView("list");
      setSelectedSessionId(null);
      setFollowTail(true);
      return;
    }

    if (key.upArrow || input === "k") {
      setFollowTail(false);
      setScrollOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setScrollOffset((current) => {
        const next = Math.min(maxScrollOffset, current + 1);
        if (next >= maxScrollOffset) {
          setFollowTail(true);
        }
        return next;
      });
    }
  });

  if (view === "waiting") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Waiting for a matching session…</Text>
        <Text dimColor>
          {props.provider ? `provider=${props.provider}` : "provider=any"}{" "}
          {props.sessionId ? `session=${props.sessionId}` : "latest=true"}
        </Text>
        {props.cwd ? <Text dimColor>cwd={props.cwd}</Text> : null}
        <Text dimColor>q quit · b back</Text>
      </Box>
    );
  }

  if (view === "detail" && selectedDescriptor) {
    return (
      <SessionDetailView
        descriptor={selectedDescriptor}
        snapshot={snapshot}
        messages={messages}
        scrollOffset={scrollOffset}
        visibleHeight={visibleHeight}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Agent Translator TUI</Text>
      <Text dimColor>q quit · arrows/j/k move · Enter attach</Text>
      <Text dimColor>
        {props.provider ? `filter=${props.provider}` : "filter=all"}
        {props.cwd ? ` · cwd=${props.cwd}` : ""}
        {" · "}
        {visibleSessions.length} sessions
      </Text>
      <Box marginTop={1}>
        <SessionListView sessions={visibleSessions} selectedIndex={selectedIndex} />
      </Box>
    </Box>
  );
}
