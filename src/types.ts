export type StatusMode = "minimal" | "normal" | "detailed";
export type StatusLayout = "tiny1";
export type ProgressMode = "strict" | "predictive";

export type RunPhase = "idle" | "queued" | "running" | "thinking" | "tool" | "sending" | "done" | "error";

export type StatusbarPluginConfig = {
  enabledByDefault: boolean;
  defaultMode: StatusMode;
  defaultLayout: StatusLayout;
  defaultProgressMode: ProgressMode;
  throttleMs: number;
  minThrottleMs: number;
  liveTickMs: number;
  maxRetriesEdit: number;
  maxRetriesSend: number;
  autoHideSeconds: number;
  showInlineControls: boolean;
  newMessagePerRun: boolean;
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
  layout: StatusLayout;
  progressMode: ProgressMode;
  pinMode: boolean;
  buttonsEnabled: boolean;
  historyRuns: number;
  avgDurationMs: number;
  avgSteps: number;
  /** v2.0: per-tool average duration (ms) for ETA estimation */
  toolAvgDurations: Record<string, number>;
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
  runNumber: number;
  queuedCount: number;
  currentRunSteps: number;
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
  maxRunTimer: ReturnType<typeof setTimeout> | null;
  pendingDelivery: boolean;
  pendingDeliveryTimer: ReturnType<typeof setTimeout> | null;
  currentRunId: string | null;
  isThinkingRun: boolean;
  predictedSteps: number;
  toolDurationsRaw: Map<string, number[]>;
  thinkingLevel: string | null;
  lastHookAtMs: number;
  /** fix #32: true while a compaction run is in progress — suppresses flushes to avoid edit conflicts */
  compacting: boolean; // always false by default, set by before_compaction/after_compaction hooks
  /** fix #38: timestamp when the final llm_output (no tool_use) fired — used for stats fallback */
  llmFinishedAtMs: number | null;
};

export type TelegramInlineButtons = Array<Array<{ text: string; callback_data: string }>>;
