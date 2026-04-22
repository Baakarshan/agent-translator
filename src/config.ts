import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderId, TranslatorConfig } from "./types.js";

export const APP_NAME = "agent-translator";
export const APP_HOME = path.join(os.homedir(), ".agent-translator");
export const CACHE_PATH = path.join(APP_HOME, "translations.json");
export const DEBUG_LOG_PATH = path.join(APP_HOME, "debug.log");
export const TRANSLATION_PROMPT_VERSION = "v1";
export const TRANSLATION_DEBOUNCE_MS = 800;
export const DEFAULT_TRANSLATOR_BASE_URL = "https://apicodex.xyz";
export const DEFAULT_TRANSLATOR_MODEL = "gpt-5.2";
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_ENV_PATH = path.join(PROJECT_ROOT, ".env.local");

type LocalEnvMap = Record<string, string>;

function parseLocalEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnv(): LocalEnvMap {
  try {
    const content = readFileSync(LOCAL_ENV_PATH, "utf8");
    const values: LocalEnvMap = {};

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1);
      if (!key) {
        continue;
      }
      values[key] = parseLocalEnvValue(rawValue);
    }

    return values;
  } catch {
    return {};
  }
}

const LOCAL_ENV = loadLocalEnv();

function readConfigValue(key: string): string | undefined {
  return process.env[key] ?? LOCAL_ENV[key];
}

export function getProviderRoot(provider: ProviderId): string {
  if (provider === "codex") {
    return path.join(os.homedir(), ".codex", "sessions");
  }
  return path.join(os.homedir(), ".claude", "projects");
}

export function getTranslatorConfig(): TranslatorConfig {
  return {
    apiKey: readConfigValue("AGENT_TRANSLATOR_API_KEY") ?? null,
    baseUrl: (readConfigValue("AGENT_TRANSLATOR_BASE_URL") ?? DEFAULT_TRANSLATOR_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: readConfigValue("AGENT_TRANSLATOR_MODEL") ?? DEFAULT_TRANSLATOR_MODEL,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    debounceMs: TRANSLATION_DEBOUNCE_MS,
  };
}
