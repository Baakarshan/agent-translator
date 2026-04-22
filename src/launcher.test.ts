import { describe, expect, test } from "vitest";

import { buildTerminalScript } from "./launcher.js";

describe("buildTerminalScript", () => {
  test("builds a macOS terminal command for codex and claude", () => {
    const codexScript = buildTerminalScript("codex", "/tmp/codex-project");
    const claudeScript = buildTerminalScript("claude", "/tmp/claude-project");

    expect(codexScript).toContain("tui");
    expect(codexScript).toContain("--latest");
    expect(codexScript).toContain("codex");
    expect(codexScript).toContain("--cwd");
    expect(codexScript).toContain("/tmp/codex-project");

    expect(claudeScript).toContain("tui");
    expect(claudeScript).toContain("--latest");
    expect(claudeScript).toContain("claude");
    expect(claudeScript).toContain("--cwd");
    expect(claudeScript).toContain("/tmp/claude-project");
  });
});
