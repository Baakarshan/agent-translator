# Agent Translator TUI v1.1

Chinese README: [README.zh-CN.md](./README.zh-CN.md)

Read-only Chinese reading TUI for Codex and Claude Code.

It keeps the native agent running in its original terminal and shows Chinese-only assistant output in a separate TUI window:

- prose replies are translated into Simplified Chinese
- assistant replies that are already in Chinese are shown directly without re-sending them to the model
- markdown tables are rendered as terminal box tables when possible
- code blocks, commands, tool calls, diffs, and shell-like output are converted into concise Chinese summaries
- long live transcripts are translated through a serialized queue to reduce bursty `429` failures

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
agent-translator tui --provider claude --session <id>
```

## TUI keys

- `Ctrl+C` or `q`: quit
- `b`: back to session list
- Arrow keys: move in session list
- `Enter`: attach from session list

Transcript scrolling uses the terminal's native scroll behavior, including touchpad two-finger scrolling in Ghostty or Terminal.app.

## Output mode

- `你`: user message, shown as original text
- `翻译`: translated Chinese prose/table output
- `命令` / `工具` / `代码` / `改动` / `输出` / `表格`: category-specific Chinese rendering
- `状态`: queued, generating, or failed assistant row state

## Rendering notes

- The TUI uses a warm low-noise palette closer to Claude Code than the previous saturated colors.
- Markdown tables are converted into box-drawing tables in the terminal when the structure is simple enough.
- Transcript content is rendered as plain terminal text, not a full markdown editor. Headings, lists, and prose still rely on terminal wrapping behavior.
- Codex `exec_command` and `apply_patch` activity are normalized back into human-readable `命令` / `工具` rows so live sessions still show what ran or what changed without dumping raw JSON payloads.
- Command and tool rows are summarized locally and cached immediately, which reduces background redraws compared with the older model-queue path.

## Session matching

Wrapper commands pass the current working directory into the TUI, so `agent-translator codex --tui` and `agent-translator claude --tui` attach to the latest matching session in the current project instead of jumping to another project.

On macOS, the launcher now tries Ghostty first via `/Applications/Ghostty.app`. If Ghostty can't be launched, it falls back to Terminal.app.

You can also attach the TUI to the active Codex desktop conversation by passing its session id directly. The same session files under `~/.codex/sessions/` are used by both the desktop app and the CLI.

## Verify

```bash
npm run verify
```
