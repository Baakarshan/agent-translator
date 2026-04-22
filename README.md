# Agent Translator TUI v1

Chinese README: [README.zh-CN.md](./README.zh-CN.md)

Read-only Chinese reading TUI for Codex and Claude Code.

It keeps the native agent running in its original terminal and shows Chinese-only assistant output in a separate TUI window:

- prose replies are translated into Simplified Chinese
- code blocks, commands, tool calls, diffs, and shell-like output are converted into concise Chinese summaries

## Requirements

- Node.js 20+
- macOS for `--tui` auto-open support
- Native `codex` and/or `claude` CLI already installed

## Install

```bash
cd /Users/baakarshan/Developer/products/agent-translator
cp .env.local.example .env.local
npm install
npm run install:global
```

After that, the global command is available:

```bash
agent-translator --help
```

## Local config

Set your translation provider values in `.env.local`:

```bash
AGENT_TRANSLATOR_API_KEY=your-api-key
AGENT_TRANSLATOR_BASE_URL=https://apicodex.xyz
AGENT_TRANSLATOR_MODEL=gpt-5.2
```

If your gateway exposes `/v1/responses`, set:

```bash
AGENT_TRANSLATOR_BASE_URL=https://your-host/v1
```

## Usage

Run Codex in the current terminal and open a separate Chinese TUI:

```bash
agent-translator codex --tui
```

Run Claude Code in the current terminal and open a separate Chinese TUI:

```bash
agent-translator claude --tui
```

Open only the TUI and attach to the latest matching session:

```bash
agent-translator tui --latest --provider codex
agent-translator tui --latest --provider claude
```

Attach to a specific session id:

```bash
agent-translator tui --provider codex --session <id>
```

## TUI keys

- `Ctrl+C` or `q`: quit
- `b`: back to session list
- Arrow keys: move in session list
- `Enter`: attach from session list

Transcript scrolling uses the terminal's native scroll behavior, including touchpad two-finger scrolling in Ghostty or Terminal.app.

## Output mode

- `你`: user message, shown as original text
- `译`: translated Chinese prose/table output
- `摘要`: Chinese summary for code, commands, tool calls, diffs, and shell-like output
- `状态`: queued, generating, or failed assistant row state

## Session matching

Wrapper commands pass the current working directory into the TUI, so `agent-translator codex --tui` and `agent-translator claude --tui` attach to the latest matching session in the current project instead of jumping to another project.

On macOS, the launcher now tries Ghostty first via `/Applications/Ghostty.app`. If Ghostty can't be launched, it falls back to Terminal.app.

## Verify

```bash
npm run verify
```
