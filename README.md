# Agent Translator TUI v1

Read-only translation TUI for Codex and Claude Code.

It keeps the native agent running in its original terminal and shows English assistant output plus Simplified Chinese translations in a separate TUI window.

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

Run Codex in the current terminal and open a separate translation TUI:

```bash
agent-translator codex --tui
```

Run Claude Code in the current terminal and open a separate translation TUI:

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
- `j` / `k` or arrow keys: scroll
- `Enter`: attach from session list

## Translation status

- `ZH ~ [queued]`: waiting for translation
- `ZH ~ [translating]`: request in progress
- `ZH >`: translated live
- `ZH =`: served from local cache
- `ZH ! [failed: ...]`: translation request failed

## Session matching

Wrapper commands pass the current working directory into the TUI, so `agent-translator codex --tui` and `agent-translator claude --tui` attach to the latest matching session in the current project instead of jumping to another project.

## Verify

```bash
npm run verify
```
