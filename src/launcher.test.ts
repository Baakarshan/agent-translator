import { describe, expect, test } from "vitest";

import { buildTerminalScript } from "./launcher.js";

describe("buildTerminalScript", () => {
  test("builds a macOS terminal command for codex and claude", () => {
    const codexScript = buildTerminalScript("codex");
    const claudeScript = buildTerminalScript("claude");

    expect(codexScript).toContain("tui");
    expect(codexScript).toContain("--latest");
    expect(codexScript).toContain("codex");

    expect(claudeScript).toContain("tui");
    expect(claudeScript).toContain("--latest");
    expect(claudeScript).toContain("claude");
  });
});
