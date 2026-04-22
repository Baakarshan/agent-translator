import { describe, expect, test, vi } from "vitest";

import { getTranslatorConfig } from "../config.js";
import { TranslatorClient, getGenerationSystemPrompt } from "./client.js";

describe("TranslatorClient", () => {
  test("uses translation prompts for prose and summary prompts for technical blocks", () => {
    expect(getGenerationSystemPrompt("prose", "translate")).toContain("Translate the assistant message");
    expect(getGenerationSystemPrompt("command", "summarize")).toContain("Write a concise Simplified Chinese summary");
    expect(getGenerationSystemPrompt("command", "summarize")).toContain("Do not copy literal shell commands");
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

    const result = await client.generate({
      originalText: "Please keep `/tmp/app.ts` unchanged.",
      kind: "prose",
      displayMode: "translate",
    });
    expect(result).toBe("这是翻译结果");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.2");
    expect(body.input[0].content[0].text).toContain("Simplified Chinese");
    expect(body.input[1].content[0].text).toContain("/tmp/app.ts");
  });
});
