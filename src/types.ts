export type ProviderId = "codex" | "claude";

export type MessageRole = "user" | "assistant";

export type MessageKind =
  | "prose"
  | "code"
  | "command"
  | "tool"
  | "diff"
  | "shell"
  | "table"
  | "unknown";

export type DisplayMode = "translate" | "summarize" | "skip";

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
  kind: MessageKind;
  displayMode: DisplayMode;
  originalText: string;
  summaryText: string | null;
  displayText: string | null;
  timestamp: string;
}

export interface DisplayMessage extends ParsedMessage {
  summaryText: string | null;
  displayText: string | null;
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
