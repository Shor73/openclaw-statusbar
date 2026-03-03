import { vi } from "vitest";
import type { SessionRuntime, TelegramTarget, ConversationPrefs } from "../src/types.js";

export function createMockTarget(overrides?: Partial<TelegramTarget>): TelegramTarget {
  return {
    channelId: "telegram",
    accountId: "test-account",
    conversationId: "telegram:-100123",
    chatId: "-100123",
    threadId: null,
    ...overrides,
  };
}

export function createMockSession(overrides?: Partial<SessionRuntime>): SessionRuntime {
  return {
    sessionKey: "chat|-100123|main",
    target: createMockTarget(),
    phase: "idle",
    runNumber: 0,
    queuedCount: 0,
    currentRunSteps: 0,
    startedAtMs: Date.now(),
    endedAtMs: null,
    toolName: null,
    provider: null,
    model: null,
    usageInput: null,
    usageOutput: null,
    lastUsageRenderAtMs: 0,
    error: null,
    lastRenderedText: null,
    lastRenderedControlsKey: null,
    lastRenderedAtMs: 0,
    nextAllowedAtMs: 0,
    desiredRevision: 0,
    renderedRevision: 0,
    renderTimer: null,
    isFlushing: false,
    hideTimer: null,
    maxRunTimer: null,
    pendingDelivery: false,
    pendingDeliveryTimer: null,
    currentRunId: null,
    isThinkingRun: false,
    predictedSteps: 0,
    toolDurationsRaw: new Map(),
    thinkingLevel: null,
    lastHookAtMs: Date.now(),
    ...overrides,
  };
}

export function createMockPrefs(overrides?: Partial<ConversationPrefs>): ConversationPrefs {
  return {
    enabled: true,
    mode: "normal",
    layout: "tiny1",
    progressMode: "predictive",
    pinMode: false,
    buttonsEnabled: true,
    historyRuns: 10,
    avgDurationMs: 30000,
    avgSteps: 5,
    toolAvgDurations: {},
    statusMessagesByThread: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function createMockApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { get: vi.fn() },
    pluginConfig: {},
    runtime: {
      state: { resolveStateDir: vi.fn(() => "/tmp/test-state") },
      channel: {
        telegram: {
          resolveTelegramToken: vi.fn(() => ({ token: "test-token" })),
          sendMessageTelegram: vi.fn(),
          messageActions: { handleAction: vi.fn() },
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({ sessionKey: "agent:main:telegram:dm:123" })),
        },
      },
    },
    registerCommand: vi.fn(),
    on: vi.fn(),
  };
}
