import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { getProviderRoot } from "./config.js";
import { writeDebugLog } from "./debug-log.js";
import { readClaudeDescriptor } from "./providers/claude.js";
import { readCodexDescriptor } from "./providers/codex.js";
import type { ProviderId, SessionDescriptor, SessionSelector } from "./types.js";

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

function getDescriptorReader(provider: ProviderId): (filePath: string) => Promise<SessionDescriptor | null> {
  return provider === "codex" ? readCodexDescriptor : readClaudeDescriptor;
}

function isProviderSessionFile(provider: ProviderId, filePath: string): boolean {
  if (!filePath.endsWith(".jsonl")) {
    return false;
  }
  if (provider === "codex") {
    return path.basename(filePath).startsWith("rollout-");
  }
  return !filePath.includes(`${path.sep}subagents${path.sep}`);
}

function getProviderForFile(filePath: string, roots: Map<ProviderId, string>): ProviderId | null {
  for (const [provider, root] of roots.entries()) {
    if (filePath.startsWith(root) && isProviderSessionFile(provider, filePath)) {
      return provider;
    }
  }
  return null;
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
  const filteredByCwd = targetCwd
    ? filteredByProvider.filter((session) => normalizeCwd(session.cwd) === targetCwd)
    : filteredByProvider;
  const filtered = typeof selector.afterMs === "number"
    ? filteredByCwd.filter((session) => session.lastActivityMs >= selector.afterMs!)
    : filteredByCwd;

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
  private readonly sessionMap = new Map<string, SessionDescriptor>();
  private readonly providerRoots: Map<ProviderId, string>;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pendingRefresh = false;
  private refreshPromise: Promise<void> | null = null;

  constructor(provider?: ProviderId) {
    super();
    this.provider = provider;
    const providers: ProviderId[] = provider ? [provider] : ["codex", "claude"];
    this.providerRoots = new Map(providers.map((currentProvider) => [
      currentProvider,
      getProviderRoot(currentProvider),
    ]));
  }

  public getSessions(): SessionDescriptor[] {
    return this.sessions;
  }

  public async start(): Promise<void> {
    await this.refreshAll();
    const roots = [...this.providerRoots.values()];

    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100,
      },
    });

    const scheduleRefreshAll = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        void this.refreshAll();
      }, 150);
    };

    this.watcher.on("add", (filePath) => {
      void this.refreshFile(filePath);
    });
    this.watcher.on("change", (filePath) => {
      void this.refreshFile(filePath);
    });
    this.watcher.on("unlink", (filePath) => {
      const provider = getProviderForFile(filePath, this.providerRoots);
      if (!provider) {
        return;
      }
      this.sessionMap.delete(filePath);
      this.emitSessions();
    });
    this.watcher.on("addDir", scheduleRefreshAll);
    this.watcher.on("unlinkDir", scheduleRefreshAll);
    this.watcher.on("error", (error) => {
      void writeDebugLog("sessionIndex.watch", {
        provider: this.provider ?? "all",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.refreshPromise;
    await this.watcher?.close();
    this.watcher = null;
  }

  private emitSessions(): void {
    this.sessions = [...this.sessionMap.values()].sort((left, right) => right.lastActivityMs - left.lastActivityMs);
    this.emit("update", this.sessions);
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshPromise) {
      this.pendingRefresh = true;
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const sessions = await discoverSessions(this.provider);
        this.sessionMap.clear();
        for (const session of sessions) {
          this.sessionMap.set(session.filePath, session);
        }
        this.emitSessions();
      } finally {
        this.refreshPromise = null;
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          await this.refreshAll();
        }
      }
    })();

    return this.refreshPromise;
  }

  private async refreshFile(filePath: string): Promise<void> {
    const provider = getProviderForFile(filePath, this.providerRoots);
    if (!provider) {
      return;
    }

    try {
      const descriptor = await getDescriptorReader(provider)(filePath);
      if (descriptor) {
        this.sessionMap.set(filePath, descriptor);
      } else {
        this.sessionMap.delete(filePath);
      }
      this.emitSessions();
    } catch (error) {
      await writeDebugLog("sessionIndex.refreshFile", {
        provider,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
