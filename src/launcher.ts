import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";

import type { ProviderId } from "./types.js";

export const GHOSTTY_APP_PATH = "/Applications/Ghostty.app";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSelfCommand(args: string[]): string {
  const command = [process.execPath, ...process.execArgv, process.argv[1], ...args].filter(
    (value): value is string => typeof value === "string",
  );
  return command.map(shellEscape).join(" ");
}

export function buildTerminalScript(provider: ProviderId, cwd: string, afterMs?: number): string {
  const args = ["tui", "--latest", "--provider", provider, "--cwd", cwd];
  if (typeof afterMs === "number") {
    args.push("--after-ms", String(afterMs));
  }
  return buildSelfCommand(args);
}

export function buildGhosttyOpenArgs(provider: ProviderId, cwd: string, afterMs?: number): string[] {
  return [
    "-na",
    GHOSTTY_APP_PATH,
    "--args",
    "-e",
    "zsh",
    "-lc",
    buildTerminalScript(provider, cwd, afterMs),
  ];
}

export function buildTerminalAppleScript(provider: ProviderId, cwd: string, afterMs?: number): string {
  const command = buildTerminalScript(provider, cwd, afterMs).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "Terminal" to do script "${command}"`;
}

async function canLaunchGhostty(): Promise<boolean> {
  try {
    await access(GHOSTTY_APP_PATH, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runLauncherCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function openTuiTerminal(provider: ProviderId, cwd: string, afterMs?: number): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic TUI terminal launching is only supported on macOS");
  }

  if (await canLaunchGhostty()) {
    try {
      await runLauncherCommand("open", buildGhosttyOpenArgs(provider, cwd, afterMs));
      return;
    } catch {
      // Fall back to Terminal.app if Ghostty fails to launch.
    }
  }

  await runLauncherCommand("osascript", ["-e", buildTerminalAppleScript(provider, cwd, afterMs)]);
}

export async function runProviderBinary(
  provider: ProviderId,
  args: string[],
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(provider, args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}
