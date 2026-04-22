import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { getProviderRoot } from "./config.js";
import { writeDebugLog } from "./debug-log.js";
import { readClaudeDescriptor } from "./providers/claude.js";
import { readCodexDescriptor } from "./providers/codex.js";
import type { ProviderId, SessionDescriptor } from "./types.js";

type SessionSelector = {
  provider?: ProviderId | undefined;
  latest?: boolean | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
};

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      results.push(fullPath);
    }
  }

  return results;
}

async function collectProviderFiles(provider: ProviderId): Promise<string[]> {
  const root = getProviderRoot(provider);
  const files = await walkFiles(root);
  if (provider === "codex") {
    return files.filter((file) => file.endsWith(".jsonl") && path.basename(file).startsWith("rollout-"));
  }
  return files.filter(
    (file) => file.endsWith(".jsonl") && !file.includes(`${path.sep}subagents${path.sep}`),
  );
}

export async function discoverSessions(provider?: ProviderId): Promise<SessionDescriptor[]> {
  const providers: ProviderId[] = provider ? [provider] : ["codex", "claude"];
  const descriptors: SessionDescriptor[] = [];

  for (const currentProvider of providers) {
    const files = await collectProviderFiles(currentProvider);
    for (const file of files) {
      try {
        const descriptor =
          currentProvider === "codex"
            ? await readCodexDescriptor(file)
            : await readClaudeDescriptor(file);
        if (descriptor) {
          descriptors.push(descriptor);
        }
      } catch (error) {
        await writeDebugLog("discoverSessions", {
          provider: currentProvider,
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return descriptors.sort((left, right) => right.lastActivityMs - left.lastActivityMs);
}

export function selectSessionDescriptor(
  sessions: SessionDescriptor[],
  selector: SessionSelector,
): SessionDescriptor | null {
  const filteredByProvider = selector.provider
    ? sessions.filter((session) => session.provider === selector.provider)
    : sessions;
  const targetCwd = selector.cwd ? normalizeCwd(selector.cwd) : null;
  const filtered = targetCwd
    ? filteredByProvider.filter((session) => normalizeCwd(session.cwd) === targetCwd)
    : filteredByProvider;

  if (selector.sessionId) {
    return filtered.find((session) => session.sessionId === selector.sessionId) ?? null;
  }

  if (selector.latest) {
    return filtered[0] ?? null;
  }

  return null;
}

export class SessionIndex extends EventEmitter {
  private readonly provider: ProviderId | undefined;
  private watcher: FSWatcher | null = null;
  private sessions: SessionDescriptor[] = [];
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(provider?: ProviderId) {
    super();
    this.provider = provider;
  }

  public getSessions(): SessionDescriptor[] {
    return this.sessions;
  }

  public async start(): Promise<void> {
    await this.scan();
    const providers: ProviderId[] = this.provider ? [this.provider] : ["codex", "claude"];
    const roots = providers.map((provider) => getProviderRoot(provider));

    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100,
      },
    });

    const scheduleScan = () => {
      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
      }
      this.scanTimer = setTimeout(() => {
        void this.scan();
      }, 150);
    };

    this.watcher.on("add", scheduleScan);
    this.watcher.on("change", scheduleScan);
    this.watcher.on("unlink", scheduleScan);
    this.watcher.on("error", (error) => {
      void writeDebugLog("sessionIndex.watch", {
        provider: this.provider ?? "all",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    await this.watcher?.close();
    this.watcher = null;
  }

  private async scan(): Promise<void> {
    this.sessions = await discoverSessions(this.provider);
    this.emit("update", this.sessions);
  }
}
