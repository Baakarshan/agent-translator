export type ProviderId = "codex" | "claude";

export type MessageRole = "user" | "assistant";

export type TranslationStatus =
  | "idle"
  | "scheduled"
  | "translating"
  | "translated"
  | "cached"
  | "failed";

export interface ParsedMessage {
  provider: ProviderId;
  sessionId: string;
  messageId: string;
  role: MessageRole;
  originalText: string;
  timestamp: string;
}

export interface DisplayMessage extends ParsedMessage {
  translatedText: string | null;
  translationStatus: TranslationStatus;
  translationError?: string | undefined;
}

export interface SessionDescriptor {
  provider: ProviderId;
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string;
  lastActivityAt: string;
  lastActivityMs: number;
  live: boolean;
}

export interface SessionSnapshot extends SessionDescriptor {
  messages: ParsedMessage[];
}

export interface TranslatorConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  promptVersion: string;
  debounceMs: number;
}

export interface TranslationResult {
  text: string;
  cached: boolean;
}
