#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import React from "react";
import { Command, Option } from "commander";
import { render } from "ink";

import { openTuiTerminal, runProviderBinary } from "./launcher.js";
import { App } from "./tui/app.js";
import type { ProviderId } from "./types.js";

const WRAPPED_COMMAND_HELP = [
  "",
  "Wrapper shortcuts:",
  "  codex [codex args...] [--tui]           Run native Codex in this terminal",
  "  claude [claude args...] [--tui]         Run native Claude Code in this terminal",
  "  tui [--latest] [--provider <provider>]  Open the read-only translation TUI",
  "      [--session <id>]",
].join("\n");

export function parseWrappedProviderArgv(argv: string[]): { openTui: boolean; args: string[] } {
  let openTui = false;
  const args: string[] = [];

  for (const argument of argv) {
    if (argument === "--tui") {
      openTui = true;
      continue;
    }
    args.push(argument);
  }

  return { openTui, args };
}

export function prepareTuiScreen(stream: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout): void {
  if (!stream.isTTY) {
    return;
  }

  // Clear the visible screen and scrollback so the TUI opens without shell noise above it.
  stream.write("\x1b[2J\x1b[3J\x1b[H");
}

async function runWrappedProvider(provider: ProviderId, args: string[], openTui: boolean): Promise<void> {
  if (openTui) {
    await openTuiTerminal(provider, process.cwd(), Date.now());
  }

  const exitCode = await runProviderBinary(provider, args);
  process.exitCode = exitCode ?? 1;
}

async function renderTui(options: {
  provider?: ProviderId | undefined;
  latest?: boolean | undefined;
  session?: string | undefined;
  cwd?: string | undefined;
  afterMs?: number | undefined;
}): Promise<void> {
  prepareTuiScreen();
  const props = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.latest ? { latest: options.latest } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(typeof options.afterMs === "number" ? { afterMs: options.afterMs } : {}),
  };
  const instance = render(
    React.createElement(App, props),
  );

  await instance.waitUntilExit();
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const rawCommand = rawArgs[0];
  if (rawCommand === "codex" || rawCommand === "claude") {
    const { openTui, args } = parseWrappedProviderArgv(rawArgs.slice(1));
    await runWrappedProvider(rawCommand, args, openTui);
    return;
  }

  const program = new Command();

  program.name("agent-translator").description("Read-only translation TUI for Codex and Claude");
  program.on("--help", () => {
    process.stdout.write(`${WRAPPED_COMMAND_HELP}\n`);
  });

  program
    .command("tui")
    .option("--latest", "Attach to the latest matching session")
    .option("--provider <provider>", "Provider filter", (value: string) => value as ProviderId)
    .option("--session <id>", "Attach to a specific session id")
    .option("--cwd <path>", "Limit session matching to a working directory")
    .addOption(
      new Option("--after-ms <timestamp>", "Internal minimum session activity timestamp")
        .argParser((value: string) => Number.parseInt(value, 10))
        .hideHelp(),
    )
    .action(async (options: {
      latest?: boolean;
      provider?: ProviderId;
      session?: string;
      cwd?: string;
      afterMs?: number;
    }) => {
      await renderTui(options);
    });

  await program.parseAsync(process.argv);
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(realpathSync(path.resolve(entryPath))).href;
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
