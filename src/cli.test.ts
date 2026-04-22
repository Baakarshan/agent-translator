import { describe, expect, test } from "vitest";

import { parseWrappedProviderArgv } from "./cli.js";

describe("parseWrappedProviderArgv", () => {
  test("strips --tui and preserves provider arguments", () => {
    expect(parseWrappedProviderArgv(["--tui", "hello", "--foo", "bar"])).toEqual({
      openTui: true,
      args: ["hello", "--foo", "bar"],
    });
  });
});
