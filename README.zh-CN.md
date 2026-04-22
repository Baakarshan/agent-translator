# Agent Translator TUI v1

English README: [README.md](./README.md)

这是一个只读的翻译 TUI，支持 Codex 和 Claude Code。

它保留原生 agent 在原终端里运行，同时在单独的 TUI 窗口中显示英文 assistant 输出和对应的简体中文翻译。

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

在当前终端运行 Codex，并自动打开单独的翻译 TUI：

```bash
agent-translator codex --tui
```

在当前终端运行 Claude Code，并自动打开单独的翻译 TUI：

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
- `j` / `k` 或方向键：滚动
- `Enter`：从会话列表附着

## 翻译状态

- `ZH ~ [queued]`：等待翻译
- `ZH ~ [translating]`：翻译请求进行中
- `ZH >`：实时翻译结果
- `ZH =`：本地缓存命中
- `ZH ! [failed: ...]`：翻译请求失败

## 会话匹配

包装命令会把当前工作目录传给 TUI，所以 `agent-translator codex --tui` 和 `agent-translator claude --tui` 会优先附着到当前项目目录下的最新会话，而不是跳到别的项目。

## 自检

```bash
npm run verify
```
