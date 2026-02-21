import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TelegramTarget } from "./types.js";

type MessageReceivedContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

type MessageReceivedEvent = {
  from?: string;
  metadata?: Record<string, unknown>;
};

type RoutePeer = { kind: "dm" | "group"; id: string };

const TELEGRAM_PREFIX       = "telegram:";
const TELEGRAM_GROUP_PREFIX = "telegram:group:";

// fix #6: regex come costanti di modulo — evita ricreazione a ogni chiamata
const RE_TOPIC_SUFFIX  = /:topic:(-?\d+)$/;
const RE_THREAD_SUFFIX = /:thread:(-?\d+)$/;
const RE_HAS_TOPIC_OR_THREAD = /:(topic|thread):/;

function normalizeAccountId(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed || "default";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseChatIdFromReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith(TELEGRAM_PREFIX)) return null;

  if (trimmed.startsWith(TELEGRAM_GROUP_PREFIX)) {
    const peer = trimmed.slice(TELEGRAM_GROUP_PREFIX.length);
    if (!peer) return null;
    // fix #13: split()[0] è sempre definito — ?? peer è dead code, sostituito con [0]!
    const withoutTopic  = peer.split(":topic:")[0]!;
    const withoutThread = withoutTopic.split(":thread:")[0]!;
    return withoutThread.trim() || null;
  }

  const rest = trimmed.slice(TELEGRAM_PREFIX.length);
  if (!rest) return null;
  const withoutTopic  = rest.split(":topic:")[0]!;
  const withoutThread = withoutTopic.split(":thread:")[0]!;
  return withoutThread.trim() || null;
}

function parseThreadIdFromReference(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // fix #6: uso costanti RE_TOPIC_SUFFIX / RE_THREAD_SUFFIX
  const topicMatch = RE_TOPIC_SUFFIX.exec(trimmed);
  if (topicMatch?.[1]) return asInt(topicMatch[1]);
  const threadMatch = RE_THREAD_SUFFIX.exec(trimmed);
  if (threadMatch?.[1]) return asInt(threadMatch[1]);
  return null;
}

function normalizeConversationId(raw: string | null): string | null {
  if (!raw) return null;
  const chatId = parseChatIdFromReference(raw);
  if (!chatId) return null;
  return `${TELEGRAM_PREFIX}${chatId}`;
}

function resolveConversationCandidate(params: {
  ctxConversationId?: string;
  metadata: Record<string, unknown>;
  from?: string;
}): string | null {
  const primary = normalizeConversationId(asString(params.ctxConversationId) ?? null);
  if (primary) return primary;
  const fallbackOriginating = normalizeConversationId(asString(params.metadata.originatingTo));
  if (fallbackOriginating) return fallbackOriginating;
  const fallbackTo = normalizeConversationId(asString(params.metadata.to));
  if (fallbackTo) return fallbackTo;
  return normalizeConversationId(asString(params.from));
}

function resolveThreadCandidate(params: {
  metadata: Record<string, unknown>;
  from?: string;
  conversationId: string;
}): number | null {
  const fromMetadata = asInt(params.metadata.threadId);
  if (fromMetadata != null) return fromMetadata;
  const fromFrom = params.from ? parseThreadIdFromReference(params.from) : null;
  if (fromFrom != null) return fromFrom;
  return parseThreadIdFromReference(params.conversationId);
}

function resolveRoutePeer(
  event: MessageReceivedEvent,
  target: TelegramTarget,
): { peer: RoutePeer; parentPeer?: RoutePeer } {
  const from = (event.from ?? "").trim();
  if (from.startsWith(TELEGRAM_GROUP_PREFIX)) {
    let peerId = from.slice(TELEGRAM_GROUP_PREFIX.length).trim();
    if (!peerId) peerId = target.chatId;
    // fix #6: uso costante RE_HAS_TOPIC_OR_THREAD
    const hasTopic = RE_HAS_TOPIC_OR_THREAD.test(peerId);
    if (!hasTopic && target.threadId != null) {
      peerId = `${peerId}:topic:${target.threadId}`;
    }
    // fix #13: split()[0] sempre definito
    const withoutTopic  = peerId.split(":topic:")[0]!;
    const withoutThread = withoutTopic.split(":thread:")[0]!;
    const parentId = withoutThread.trim();
    return {
      peer: { kind: "group", id: peerId },
      ...(parentId && parentId !== peerId ? { parentPeer: { kind: "group", id: parentId } } : {}),
    };
  }

  const directPeer = parseChatIdFromReference(from) ?? target.chatId;
  return { peer: { kind: "dm", id: directPeer } };
}

export function resolveTelegramTargetFromMessageReceived(params: {
  event: MessageReceivedEvent;
  ctx: MessageReceivedContext;
}): TelegramTarget | null {
  const channelId = (params.ctx.channelId ?? "").trim().toLowerCase();
  if (channelId !== "telegram") return null;

  const metadata = asRecord(params.event.metadata);
  const conversationId = resolveConversationCandidate({
    ctxConversationId: params.ctx.conversationId,
    metadata,
    from: params.event.from,
  });
  if (!conversationId) return null;

  const chatId = parseChatIdFromReference(conversationId);
  if (!chatId) return null;

  return {
    channelId: "telegram",
    accountId: normalizeAccountId(params.ctx.accountId),
    conversationId,
    chatId,
    threadId: resolveThreadCandidate({ metadata, from: params.event.from, conversationId }),
  };
}

export function resolveSessionKeyFromMessageReceived(params: {
  api: OpenClawPluginApi;
  event: MessageReceivedEvent;
  target: TelegramTarget;
}): string {
  const routePeer = resolveRoutePeer(params.event, params.target);
  const route = params.api.runtime.channel.routing.resolveAgentRoute({
    cfg: params.api.config,
    channel: "telegram",
    accountId: params.target.accountId,
    peer: routePeer.peer,
    parentPeer: routePeer.parentPeer,
  });
  return route.sessionKey;
}

export function resolveTelegramTargetFromCommandContext(params: {
  channel: string;
  accountId?: string;
  to?: string;
  from?: string;
  messageThreadId?: number;
}): TelegramTarget | null {
  if ((params.channel ?? "").trim().toLowerCase() !== "telegram") return null;

  const toConversation   = normalizeConversationId(asString(params.to));
  const fromConversation = normalizeConversationId(asString(params.from));
  const conversationId   = toConversation ?? fromConversation;
  if (!conversationId) return null;

  const chatId = parseChatIdFromReference(conversationId);
  if (!chatId) return null;

  return {
    channelId: "telegram",
    accountId: normalizeAccountId(params.accountId),
    conversationId,
    chatId,
    threadId: typeof params.messageThreadId === "number" ? Math.trunc(params.messageThreadId) : null,
  };
}

export function resolveTelegramTargetFromSessionKey(sessionKey: string): TelegramTarget | null {
  const raw = sessionKey.trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 4 || parts[0] !== "agent") return null;

  const rest = parts.slice(2);
  if (rest[0] !== "telegram") return null;

  // Known forms:
  // - telegram:<accountId>:dm:<peerId>
  // - telegram:<accountId>:direct:<peerId> (legacy)
  // - telegram:dm:<peerId>
  // - telegram:direct:<peerId> (legacy)
  // - telegram:group:<peerId>
  let accountId = "default";
  let kind      = "";
  let peerId    = "";

  if (rest.length >= 4 && (rest[2] === "dm" || rest[2] === "direct")) {
    accountId = normalizeAccountId(rest[1]);
    kind      = rest[2];
    peerId    = rest.slice(3).join(":");
  } else if (
    rest.length >= 3 &&
    (rest[1] === "dm" || rest[1] === "direct" || rest[1] === "group")
  ) {
    kind   = rest[1];
    peerId = rest.slice(2).join(":");
  } else {
    return null;
  }

  if (!peerId) return null;

  // fix #13: split()[0] sempre definito
  const rawChatId       = kind === "group" ? peerId.split(":topic:")[0]! : peerId;
  const normalizedChatId = rawChatId.split(":thread:")[0]!.trim();
  if (!normalizedChatId) return null;

  const threadId = parseThreadIdFromReference(`telegram:${peerId}`);

  return {
    channelId: "telegram",
    accountId,
    conversationId: `${TELEGRAM_PREFIX}${normalizedChatId}`,
    chatId: normalizedChatId,
    threadId,
  };
}
