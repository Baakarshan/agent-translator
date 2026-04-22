import { mkdir, appendFile } from "node:fs/promises";

import { APP_HOME, DEBUG_LOG_PATH } from "./config.js";

export async function writeDebugLog(scope: string, payload: unknown): Promise<void> {
  try {
    await mkdir(APP_HOME, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      scope,
      payload,
    });
    await appendFile(DEBUG_LOG_PATH, `${line}\n`, "utf8");
  } catch {
    // Debug logging must never break the main flow.
  }
}

