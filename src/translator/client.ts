import type { DisplayMode, MessageKind, ParsedMessage, TranslatorConfig } from "../types.js";

const TRANSLATE_PROMPT = [
  "Translate the assistant message into concise Simplified Chinese.",
  "Do not output the original English text.",
  "Preserve markdown structure when practical, especially tables.",
  "Do not use internet slang, filler, or emotional phrasing.",
  "Tone: neutral, technical, direct.",
].join(" ");

const SUMMARIZE_PROMPT = [
  "Write a concise Simplified Chinese summary of the assistant content.",
  "Use 1 to 3 short sentences.",
  "Do not output the original English text.",
  "Do not repeat raw code, commands, diffs, file paths, JSON, or stack traces verbatim unless absolutely necessary.",
  "Explain only what was done, why, or the result.",
  "Tone: neutral, technical, direct.",
].join(" ");

export function getGenerationSystemPrompt(kind: MessageKind, displayMode: DisplayMode): string {
  if (displayMode === "summarize") {
    if (kind === "command") {
      return `${SUMMARIZE_PROMPT} Focus on what the command does.`;
    }
    if (kind === "diff") {
      return `${SUMMARIZE_PROMPT} Focus on the key changes in the diff.`;
    }
    if (kind === "tool") {
      return `${SUMMARIZE_PROMPT} Focus on which tool was called and for what purpose.`;
    }
    if (kind === "shell") {
      return `${SUMMARIZE_PROMPT} Focus on the execution result or conclusion.`;
    }
    if (kind === "code") {
      return `${SUMMARIZE_PROMPT} Focus on the code change or technical intent.`;
    }
    return SUMMARIZE_PROMPT;
  }

  if (kind === "table") {
    return `${TRANSLATE_PROMPT} Preserve the table layout when practical; if the table is too complex, produce a concise Chinese summary instead.`;
  }

  return TRANSLATE_PROMPT;
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

  public async generate(message: Pick<ParsedMessage, "originalText" | "kind" | "displayMode">): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("AGENT_TRANSLATOR_API_KEY is not set");
    }

    const systemPrompt = getGenerationSystemPrompt(message.kind, message.displayMode);

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
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: message.originalText }],
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
