import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CACHE_PATH } from "../config.js";

type CacheSchema = {
  entries: Record<string, { text: string; updatedAt: string }>;
};

export class TranslationCache {
  private readonly filePath: string;
  private loaded = false;
  private entries = new Map<string, { text: string; updatedAt: string }>();

  constructor(filePath = CACHE_PATH) {
    this.filePath = filePath;
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CacheSchema;
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (value && typeof value.text === "string" && typeof value.updatedAt === "string") {
          this.entries.set(key, value);
        }
      }
    } catch {
      // Missing or malformed cache should not block startup.
    }

    this.loaded = true;
  }

  public async get(key: string): Promise<string | null> {
    await this.load();
    return this.entries.get(key)?.text ?? null;
  }

  public async set(key: string, text: string): Promise<void> {
    await this.load();
    this.entries.set(key, {
      text,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const payload: CacheSchema = {
      entries: Object.fromEntries(this.entries),
    };
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
