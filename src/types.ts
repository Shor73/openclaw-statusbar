export type StatusMode = "minimal" | "normal" | "detailed";

export type RunPhase = "idle" | "queued" | "running" | "tool" | "done" | "error";

export type StatusbarPluginConfig = {
  enabledByDefault: boolean;
  defaultMode: StatusMode;
  throttleMs: number;
  minThrottleMs: number;
  maxRetries: number;
  autoHideSeconds: number;
  showInlineControls: boolean;
};

export type TelegramTarget = {
  channelId: "telegram";
  accountId: string;
  conversationId: string;
  chatId: string;
  threadId: number | null;
};

export type StatusMessageRef = {
  chatId: string;
  messageId: number;
  updatedAt: number;
};

export type ConversationPrefs = {
  enabled: boolean;
  mode: StatusMode;
  statusMessagesByThread: Record<string, StatusMessageRef>;
  updatedAt: number;
};

export type PersistedStore = {
  version: 1;
  conversations: Record<string, ConversationPrefs>;
};

export type SessionRuntime = {
  sessionKey: string;
  target: TelegramTarget;
  phase: RunPhase;
  startedAtMs: number;
  endedAtMs: number | null;
  toolName: string | null;
  provider: string | null;
  model: string | null;
  usageInput: number | null;
  usageOutput: number | null;
  lastUsageRenderAtMs: number;
  error: string | null;
  lastRenderedText: string | null;
  lastRenderedControlsKey: string | null;
  lastRenderedAtMs: number;
  nextAllowedAtMs: number;
  desiredRevision: number;
  renderedRevision: number;
  renderTimer: ReturnType<typeof setTimeout> | null;
  isFlushing: boolean;
  hideTimer: ReturnType<typeof setTimeout> | null;
};

export type TelegramInlineButtons = Array<Array<{ text: string; callback_data: string }>>;
