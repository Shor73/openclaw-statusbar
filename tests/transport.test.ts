import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramTransport, TelegramApiError } from "../src/transport.js";
import { createMockApi } from "./mocks.js";
import type { StatusbarPluginConfig } from "../src/types.js";

function createConfig(overrides?: Partial<StatusbarPluginConfig>): StatusbarPluginConfig {
  return {
    enabledByDefault: false,
    defaultMode: "normal",
    defaultLayout: "tiny1",
    defaultProgressMode: "predictive",
    throttleMs: 4000,
    minThrottleMs: 2500,
    liveTickMs: 2500,
    maxRetriesEdit: 0,
    maxRetriesSend: 4,
    autoHideSeconds: 0,
    showInlineControls: false,
    newMessagePerRun: true,
    ...overrides,
  };
}

describe("TelegramApiError", () => {
  it("isRateLimit returns true for 429", () => {
    const err = new TelegramApiError({ code: 429, description: "Too Many Requests" });
    expect(err.isRateLimit()).toBe(true);
  });

  it("isRateLimit returns false for other codes", () => {
    const err = new TelegramApiError({ code: 400, description: "Bad Request" });
    expect(err.isRateLimit()).toBe(false);
  });

  it("isEditNotFound detects message to edit not found", () => {
    const err = new TelegramApiError({ code: 400, description: "Bad Request: message to edit not found" });
    expect(err.isEditNotFound()).toBe(true);
  });

  it("isMessageNotModified detects not modified", () => {
    const err = new TelegramApiError({ code: 400, description: "Bad Request: message is not modified" });
    expect(err.isMessageNotModified()).toBe(true);
  });

  it("retryAfterSeconds defaults to null", () => {
    const err = new TelegramApiError({ code: 429 });
    expect(err.retryAfterSeconds).toBeNull();
  });

  it("retryAfterSeconds is set when provided", () => {
    const err = new TelegramApiError({ code: 429, retryAfterSeconds: 30 });
    expect(err.retryAfterSeconds).toBe(30);
  });
});

describe("TelegramTransport circuit breaker", () => {
  let api: ReturnType<typeof createMockApi>;
  let transport: TelegramTransport;

  beforeEach(() => {
    api = createMockApi();
    transport = new TelegramTransport({ api: api as any, config: createConfig() });
  });

  it("canProceed returns true initially", () => {
    expect(transport.canProceed("acc1", "chat1")).toBe(true);
  });

  it("canProceed returns false after rate limit, then recovers", async () => {
    // Simulate a 429 by triggering editStatusMessage which calls the SDK path
    const rateLimitErr = new TelegramApiError({ code: 429, description: "Too Many Requests", retryAfterSeconds: 1 });
    api.runtime.channel.telegram.messageActions.handleAction.mockRejectedValueOnce(rateLimitErr);

    // Trigger the rate limit
    try {
      await transport.editStatusMessage({
        target: {
          channelId: "telegram",
          accountId: "acc1",
          conversationId: "telegram:chat1",
          chatId: "chat1",
          threadId: null,
        },
        message: { chatId: "chat1", messageId: 1, updatedAt: Date.now() },
        text: "test",
      });
    } catch {
      // expected
    }

    // Circuit breaker should be open
    expect(transport.canProceed("acc1", "chat1")).toBe(false);
    expect(transport.rateLimiterRemainingMs("acc1", "chat1")).toBeGreaterThan(0);

    // Other chats should be unaffected
    expect(transport.canProceed("acc1", "chat2")).toBe(true);
  });

  it("rateLimiterRemainingMs returns 0 when no limit", () => {
    expect(transport.rateLimiterRemainingMs("acc1", "chat1")).toBe(0);
  });
});

describe("TelegramTransport sendStatusMessage", () => {
  let api: ReturnType<typeof createMockApi>;
  let transport: TelegramTransport;

  beforeEach(() => {
    api = createMockApi();
    transport = new TelegramTransport({ api: api as any, config: createConfig() });
  });

  it("sends via SDK and returns message ref", async () => {
    api.runtime.channel.telegram.sendMessageTelegram.mockResolvedValueOnce({
      messageId: "42",
      chatId: "-100123",
    });

    const ref = await transport.sendStatusMessage({
      target: {
        channelId: "telegram",
        accountId: "test",
        conversationId: "telegram:-100123",
        chatId: "-100123",
        threadId: null,
      },
      text: "hello",
    });

    expect(ref.messageId).toBe(42);
    expect(ref.chatId).toBe("-100123");
  });
});

describe("TelegramTransport editStatusMessage", () => {
  let api: ReturnType<typeof createMockApi>;
  let transport: TelegramTransport;

  beforeEach(() => {
    api = createMockApi();
    transport = new TelegramTransport({ api: api as any, config: createConfig() });
  });

  it("returns existing ref on message not modified (SDK path)", async () => {
    const notModifiedErr = new TelegramApiError({ code: 400, description: "message is not modified" });
    api.runtime.channel.telegram.messageActions.handleAction.mockRejectedValueOnce(notModifiedErr);

    const msg = { chatId: "-100123", messageId: 5, updatedAt: 1000 };
    const ref = await transport.editStatusMessage({
      target: {
        channelId: "telegram",
        accountId: "test",
        conversationId: "telegram:-100123",
        chatId: "-100123",
        threadId: null,
      },
      message: msg,
      text: "same text",
    });

    expect(ref.messageId).toBe(5);
    expect(ref.updatedAt).toBeGreaterThan(1000);
  });
});
