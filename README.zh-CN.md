# Agent Translator TUI v1

English README: [README.md](./README.md)

这是一个只读的中文阅读 TUI，支持 Codex 和 Claude Code。

它保留原生 agent 在原终端里运行，同时在单独的 TUI 窗口中显示中文结果：

- 普通自然语言回复会翻译成简体中文
- 代码块、命令、工具调用、diff、shell 风格输出会改写成简洁中文摘要

## 依赖

- Node.js 20+
- `--tui` 自动新开窗口当前仅支持 macOS
- 本机已安装原生 `codex` 和/或 `claude` CLI

## 安装

```bash
cd /Users/baakarshan/Developer/products/agent-translator
cp .env.local.example .env.local
npm install
npm run install:global
```

安装完成后可直接使用全局命令：

```bash
agent-translator --help
```

## 本地配置

在 `.env.local` 中填写翻译模型配置：

```bash
AGENT_TRANSLATOR_API_KEY=your-api-key
AGENT_TRANSLATOR_BASE_URL=https://apicodex.xyz
AGENT_TRANSLATOR_MODEL=gpt-5.2
```

如果你的兼容网关接口是 `/v1/responses`，则把 `base_url` 写成：

```bash
AGENT_TRANSLATOR_BASE_URL=https://your-host/v1
```

## 用法

在当前终端运行 Codex，并自动打开单独的中文 TUI：

```bash
agent-translator codex --tui
```

在当前终端运行 Claude Code，并自动打开单独的中文 TUI：

```bash
agent-translator claude --tui
```

只打开 TUI，并附着到最新会话：

```bash
agent-translator tui --latest --provider codex
agent-translator tui --latest --provider claude
```

附着到指定 session id：

```bash
agent-translator tui --provider codex --session <id>
```

## TUI 按键

- `Ctrl+C` 或 `q`：退出
- `b`：返回会话列表
- 方向键：在会话列表中选择
- `Enter`：从会话列表附着

正文浏览使用终端原生滚动，Ghostty 或 Terminal.app 中都应直接支持触控板双指上下滑动。

## 输出标签

- `你`：用户消息，保留原文
- `译`：普通自然语言或表格的中文结果
- `摘要`：代码、命令、工具调用、diff、shell 风格输出的中文摘要
- `状态`：等待生成、生成中、失败等状态提示

## 会话匹配

包装命令会把当前工作目录传给 TUI，所以 `agent-translator codex --tui` 和 `agent-translator claude --tui` 会优先附着到当前项目目录下的最新会话，而不是跳到别的项目。

macOS 下默认会优先尝试用 `/Applications/Ghostty.app` 打开 TUI；如果 Ghostty 无法启动，则自动回退到 Terminal.app。

## 自检

```bash
npm run verify
```
