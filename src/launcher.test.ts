import { describe, expect, test } from "vitest";

import { buildGhosttyOpenArgs, buildTerminalAppleScript, buildTerminalScript, GHOSTTY_APP_PATH } from "./launcher.js";

describe("buildTerminalScript", () => {
  test("builds a macOS terminal command for codex and claude", () => {
    const codexScript = buildTerminalScript("codex", "/tmp/codex-project", 123456);
    const claudeScript = buildTerminalScript("claude", "/tmp/claude-project");

    expect(codexScript).toContain("tui");
    expect(codexScript).toContain("--latest");
    expect(codexScript).toContain("codex");
    expect(codexScript).toContain("--cwd");
    expect(codexScript).toContain("/tmp/codex-project");
    expect(codexScript).toContain("--after-ms");
    expect(codexScript).toContain("123456");

    expect(claudeScript).toContain("tui");
    expect(claudeScript).toContain("--latest");
    expect(claudeScript).toContain("claude");
    expect(claudeScript).toContain("--cwd");
    expect(claudeScript).toContain("/tmp/claude-project");
  });
});

describe("buildGhosttyOpenArgs", () => {
  test("builds Ghostty-first launcher args", () => {
    const args = buildGhosttyOpenArgs("codex", "/tmp/codex-project", 123456);
    expect(args).toEqual([
      "-na",
      GHOSTTY_APP_PATH,
      "--args",
      "-e",
      "zsh",
      "-lc",
      expect.stringContaining("--provider"),
    ]);
    expect(args.at(-1)).toContain("/tmp/codex-project");
    expect(args.at(-1)).toContain("--after-ms");
  });
});

describe("buildTerminalAppleScript", () => {
  test("builds a Terminal fallback AppleScript", () => {
    const script = buildTerminalAppleScript("claude", "/tmp/claude-project", 123456);
    expect(script).toContain('tell application "Terminal" to do script');
    expect(script).toContain("claude");
    expect(script).toContain("--cwd");
    expect(script).toContain("/tmp/claude-project");
    expect(script).toContain("--after-ms");
  });
});
