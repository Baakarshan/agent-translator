import { spawn } from "node:child_process";

import type { ProviderId } from "./types.js";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSelfCommand(args: string[]): string {
  const command = [process.execPath, ...process.execArgv, process.argv[1], ...args].filter(
    (value): value is string => typeof value === "string",
  );
  return command.map(shellEscape).join(" ");
}

export function buildTerminalScript(provider: ProviderId): string {
  return buildSelfCommand(["tui", "--latest", "--provider", provider]);
}

export async function openTuiTerminal(provider: ProviderId): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic TUI terminal launching is only supported on macOS");
  }

  const command = buildTerminalScript(provider).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Terminal" to do script "${command}"`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`osascript exited with code ${code}`));
    });
  });
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
