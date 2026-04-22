import { describe, expect, test, vi } from "vitest";

import { getTranslatorConfig } from "../config.js";
import { TranslatorClient, getTranslationSystemPrompt } from "./client.js";

describe("TranslatorClient", () => {
  test("includes preservation instructions in the system prompt", () => {
    expect(getTranslationSystemPrompt()).toContain("Keep code blocks, commands, file paths, JSON, stack traces, and identifiers unchanged.");
  });

  test("sends a responses request and extracts translated text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "这是翻译结果" }],
          },
        ],
      }),
    });

    const client = new TranslatorClient(
      {
        ...getTranslatorConfig(),
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await client.translate("Please keep `/tmp/app.ts` unchanged.");
    expect(result).toBe("这是翻译结果");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.2");
    expect(body.input[0].content[0].text).toContain("Simplified Chinese");
    expect(body.input[1].content[0].text).toContain("/tmp/app.ts");
  });
});

