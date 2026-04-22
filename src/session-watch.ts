import chokidar, { type FSWatcher } from "chokidar";

import { writeDebugLog } from "./debug-log.js";
import { hashText } from "./providers/common.js";
import { parseClaudeSessionFile } from "./providers/claude.js";
import { parseCodexSessionFile } from "./providers/codex.js";
import type { SessionDescriptor, SessionSnapshot } from "./types.js";

export async function loadSessionSnapshot(
  descriptor: SessionDescriptor,
): Promise<SessionSnapshot | null> {
  return descriptor.provider === "codex"
    ? parseCodexSessionFile(descriptor.filePath)
    : parseClaudeSessionFile(descriptor.filePath);
}

export function getSnapshotContentKey(snapshot: SessionSnapshot | null): string {
  if (!snapshot) {
    return "null";
  }

  const content = snapshot.messages
    .map((message) => [
      message.role,
      message.kind,
      message.displayMode,
      message.timestamp,
      message.originalText,
    ].join("\u0000"))
    .join("\u0001");

  return `${snapshot.provider}:${snapshot.sessionId}:${snapshot.messages.length}:${hashText(content)}`;
}

export function watchSessionSnapshot(
  descriptor: SessionDescriptor,
  onUpdate: (snapshot: SessionSnapshot | null) => void,
): () => Promise<void> {
  let closed = false;
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastContentKey: string | null = null;

  const refresh = async () => {
    if (closed) {
      return;
    }
    try {
      const snapshot = await loadSessionSnapshot(descriptor);
      const nextContentKey = getSnapshotContentKey(snapshot);
      if (lastContentKey === nextContentKey) {
        return;
      }
      lastContentKey = nextContentKey;
      onUpdate(snapshot);
    } catch (error) {
      await writeDebugLog("watchSessionSnapshot.refresh", {
        provider: descriptor.provider,
        filePath: descriptor.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      if (lastContentKey === "null") {
        return;
      }
      lastContentKey = "null";
      onUpdate(null);
    }
  };

  void refresh();

  watcher = chokidar.watch(descriptor.filePath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100,
    },
  });

  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void refresh();
    }, 120);
  };

  watcher.on("add", scheduleRefresh);
  watcher.on("change", scheduleRefresh);
  watcher.on("unlink", scheduleRefresh);
  watcher.on("error", (error) => {
    void writeDebugLog("watchSessionSnapshot.watch", {
      provider: descriptor.provider,
      filePath: descriptor.filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return async () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await watcher?.close();
  };
}
