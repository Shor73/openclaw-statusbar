import { describe, it, expect } from "vitest";
import {
  resolveTelegramTargetFromMessageReceived,
  resolveTelegramTargetFromCommandContext,
  resolveTelegramTargetFromSessionKey,
} from "../src/resolver.js";

describe("resolveTelegramTargetFromMessageReceived", () => {
  it("resolves with accountId, conversationId, chatId, threadId", () => {
    const result = resolveTelegramTargetFromMessageReceived({
      event: { from: "telegram:group:-100123:topic:42", metadata: {} },
      ctx: { channelId: "telegram", accountId: "main", conversationId: "telegram:-100123" },
    });
    expect(result).not.toBeNull();
    expect(result!.accountId).toBe("main");
    expect(result!.chatId).toBe("-100123");
    expect(result!.threadId).toBe(42);
  });

  it("returns null for non-telegram channel", () => {
    const result = resolveTelegramTargetFromMessageReceived({
      event: { from: "discord:123", metadata: {} },
      ctx: { channelId: "discord", accountId: "main" },
    });
    expect(result).toBeNull();
  });

  it("resolves direct message", () => {
    const result = resolveTelegramTargetFromMessageReceived({
      event: { from: "telegram:12345", metadata: {} },
      ctx: { channelId: "telegram", accountId: "bot1", conversationId: "telegram:12345" },
    });
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("12345");
    expect(result!.threadId).toBeNull();
  });
});

describe("resolveTelegramTargetFromCommandContext", () => {
  it("resolves from to parameter", () => {
    const result = resolveTelegramTargetFromCommandContext({
      channel: "telegram",
      accountId: "main",
      to: "telegram:-100456",
    });
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("-100456");
  });

  it("returns null for non-telegram", () => {
    const result = resolveTelegramTargetFromCommandContext({
      channel: "discord",
      to: "telegram:-100456",
    });
    expect(result).toBeNull();
  });
});

describe("resolveTelegramTargetFromSessionKey", () => {
  it("resolves dm session key", () => {
    const result = resolveTelegramTargetFromSessionKey("agent:main:telegram:dm:12345");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("12345");
    expect(result!.accountId).toBe("default");
  });

  it("resolves group session key with topic", () => {
    const result = resolveTelegramTargetFromSessionKey("agent:main:telegram:group:-100123:topic:42");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("-100123");
    expect(result!.threadId).toBe(42);
  });

  it("resolves session key with accountId", () => {
    const result = resolveTelegramTargetFromSessionKey("agent:main:telegram:bot1:dm:99999");
    expect(result).not.toBeNull();
    expect(result!.accountId).toBe("bot1");
    expect(result!.chatId).toBe("99999");
  });

  it("returns null for empty/invalid key", () => {
    expect(resolveTelegramTargetFromSessionKey("")).toBeNull();
    expect(resolveTelegramTargetFromSessionKey("invalid")).toBeNull();
  });
});
