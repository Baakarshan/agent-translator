import type { TranslatorConfig } from "../types.js";

const SYSTEM_PROMPT = [
  "Translate the assistant message into concise Simplified Chinese.",
  "Keep code blocks, commands, file paths, JSON, stack traces, and identifiers unchanged.",
  "Do not add explanations.",
  "Do not use internet slang, filler, or emotional phrasing.",
  "Tone: neutral, technical, direct.",
].join(" ");

export function getTranslationSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

function extractResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const response = payload as {
    output_text?: unknown;
    output?: Array<{
      type?: unknown;
      content?: Array<{ type?: unknown; text?: unknown }>;
    }>;
  };

  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (!Array.isArray(response.output)) {
    return null;
  }

  const blocks: string[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!content || typeof content !== "object") {
        continue;
      }
      const candidate = content as { text?: unknown; type?: unknown };
      if (
        (candidate.type === "output_text" || candidate.type === "text") &&
        typeof candidate.text === "string" &&
        candidate.text.trim()
      ) {
        blocks.push(candidate.text.trim());
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join("\n");
}

export class TranslatorClient {
  private readonly config: TranslatorConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TranslatorConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  public async translate(originalText: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("AGENT_TRANSLATOR_API_KEY is not set");
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: originalText }],
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Translation request failed: ${response.status} ${text}`.trim());
    }

    const payload = await response.json();
    const text = extractResponseText(payload);
    if (!text) {
      throw new Error("Translation response did not contain text output");
    }
    return text;
  }
}

