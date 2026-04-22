import { describe, expect, test } from "vitest";

import { parseWrappedProviderArgv, prepareTuiScreen } from "./cli.js";

describe("parseWrappedProviderArgv", () => {
  test("strips --tui and preserves provider arguments", () => {
    expect(parseWrappedProviderArgv(["--tui", "hello", "--foo", "bar"])).toEqual({
      openTui: true,
      args: ["hello", "--foo", "bar"],
    });
  });

  test("clears the terminal when rendering the TUI on a tty", () => {
    const writes: string[] = [];
    prepareTuiScreen({
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    });

    expect(writes).toEqual(["\u001b[2J\u001b[3J\u001b[H"]);
  });

  test("does not clear the terminal when stdout is not a tty", () => {
    const writes: string[] = [];
    prepareTuiScreen({
      isTTY: false,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    });

    expect(writes).toEqual([]);
  });
});
