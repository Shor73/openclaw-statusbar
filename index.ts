import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import { normalizePluginConfig } from "./src/config.js";
import {
  resolveSessionKeyFromMessageReceived,
  resolveTelegramTargetFromCommandContext,
  resolveTelegramTargetFromMessageReceived,
  resolveTelegramTargetFromSessionKey,
} from "./src/resolver.js";
import { buildEnabledControls, renderStatusText } from "./src/render.js";
import { StatusbarStore } from "./src/store.js";
import { TelegramApiError, TelegramTransport } from "./src/transport.js";
import type {
  SessionRuntime,
  StatusMode,
  StatusbarPluginConfig,
  TelegramInlineButtons,
  TelegramTarget,
} from "./src/types.js";

type SessionTargetRef = {
  target: TelegramTarget;
  seenAtMs: number;
};

type SenderTargetRef = {
  target: TelegramTarget;
  seenAtMs: number;
};

const SESSION_TARGET_TTL_MS = 30 * 60 * 1000;

class StatusbarRuntime {
  private readonly api: OpenClawPluginApi;
  private readonly config: StatusbarPluginConfig;
  private readonly store: StatusbarStore;
  private readonly transport: TelegramTransport;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly sessionTargets = new Map<string, SessionTargetRef>();
  private readonly senderTargets = new Map<string, SenderTargetRef>();

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.config = normalizePluginConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    this.store = new StatusbarStore({
      stateDir,
      enabledByDefault: this.config.enabledByDefault,
      defaultMode: this.config.defaultMode,
    });
    this.transport = new TelegramTransport({ api, config: this.config });
  }

  async init(): Promise<void> {
    await this.store.load();

    this.api.registerCommand({
      name: "sbon",
      description: "Enable statusline for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => await this.handleEnableCommand(ctx),
    });

    this.api.registerCommand({
      name: "sboff",
      description: "Disable statusline for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => await this.handleDisableCommand(ctx),
    });

    this.api.registerCommand({
      name: "sbmode",
      description: "Set statusline mode: minimal|normal|detailed",
      acceptsArgs: true,
      handler: async (ctx) => await this.handleModeCommand(ctx),
    });

    this.api.registerCommand({
      name: "sbstatus",
      description: "Show current statusbar mapping for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => await this.handleStatusCommand(ctx),
    });

    this.api.registerCommand({
      name: "sbreset",
      description: "Reset statusbar message reference for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => await this.handleResetCommand(ctx),
    });

    this.api.on("message_received", async (event, ctx) => {
      await this.onMessageReceived(event, ctx);
    });

    this.api.on("before_agent_start", async (_event, ctx) => {
      await this.onBeforeAgentStart(ctx);
    });

    this.api.on("before_tool_call", async (event, ctx) => {
      await this.onBeforeToolCall(event, ctx);
    });

    this.api.on("after_tool_call", async (_event, ctx) => {
      await this.onAfterToolCall(ctx);
    });

    this.api.on("llm_output", async (event, ctx) => {
      await this.onLlmOutput(event, ctx);
    });

    this.api.on("agent_end", async (event, ctx) => {
      await this.onAgentEnd(event, ctx);
    });
  }

  private pruneSessionTargets(nowMs: number): void {
    for (const [sessionKey, entry] of this.sessionTargets.entries()) {
      if (nowMs - entry.seenAtMs > SESSION_TARGET_TTL_MS) {
        this.sessionTargets.delete(sessionKey);
      }
    }
    for (const [senderKey, entry] of this.senderTargets.entries()) {
      if (nowMs - entry.seenAtMs > SESSION_TARGET_TTL_MS) {
        this.senderTargets.delete(senderKey);
      }
    }
  }

  private trackSessionTarget(sessionKey: string, target: TelegramTarget): void {
    const nowMs = Date.now();
    this.pruneSessionTargets(nowMs);
    this.sessionTargets.set(sessionKey, { target, seenAtMs: nowMs });
  }

  private trackAgentMainAlias(sessionKey: string, target: TelegramTarget): void {
    const match = sessionKey.match(/^agent:([^:]+):/);
    const agentId = match?.[1]?.trim() || "main";
    this.trackSessionTarget(`agent:${agentId}:main`, target);
  }

  private trackSenderTarget(senderId: string | null, target: TelegramTarget): void {
    const sender = (senderId ?? "").trim();
    if (!sender) {
      return;
    }
    const nowMs = Date.now();
    this.pruneSessionTargets(nowMs);
    const key = `${target.accountId}::${sender}`;
    this.senderTargets.set(key, { target, seenAtMs: nowMs });
  }

  private resolveTargetFromSender(params: {
    senderId?: string;
    accountId?: string;
  }): TelegramTarget | null {
    const sender = (params.senderId ?? "").trim();
    if (!sender) {
      return null;
    }

    const preferredAccountId = (params.accountId ?? "").trim();
    if (preferredAccountId) {
      const direct = this.senderTargets.get(`${preferredAccountId}::${sender}`);
      if (direct) {
        direct.seenAtMs = Date.now();
        return direct.target;
      }
    }

    let best: SenderTargetRef | null = null;
    const suffix = `::${sender}`;
    for (const [key, entry] of this.senderTargets.entries()) {
      if (!key.endsWith(suffix)) {
        continue;
      }
      if (!best || entry.seenAtMs > best.seenAtMs) {
        best = entry;
      }
    }

    if (!best) {
      return null;
    }
    best.seenAtMs = Date.now();
    return best.target;
  }

  private resolveTargetForSession(sessionKey: string | undefined | null): TelegramTarget | null {
    const key = (sessionKey ?? "").trim();
    if (!key) {
      return null;
    }

    const tracked = this.sessionTargets.get(key);
    if (tracked) {
      tracked.seenAtMs = Date.now();
      return tracked.target;
    }

    const fromKey = resolveTelegramTargetFromSessionKey(key);
    if (fromKey) {
      this.trackSessionTarget(key, fromKey);
      return fromKey;
    }

    const mainSessionMatch = key.match(/^agent:([^:]+):main$/);
    if (mainSessionMatch?.[1]) {
      const accountId = mainSessionMatch[1].trim();
      if (accountId) {
        const fromStore = this.store.findMostRecentTargetForAccount(accountId);
        if (fromStore) {
          this.trackSessionTarget(key, fromStore);
          return fromStore;
        }
      }
    }

    return null;
  }

  private resolveTargetForCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
  }): TelegramTarget | null {
    const direct = resolveTelegramTargetFromCommandContext(ctx);
    if (direct) {
      return direct;
    }
    if ((ctx.channel ?? "").trim().toLowerCase() !== "telegram") {
      return null;
    }
    return this.resolveTargetFromSender({
      senderId: ctx.senderId,
      accountId: ctx.accountId,
    });
  }

  private createSessionState(params: { sessionKey: string; target: TelegramTarget }): SessionRuntime {
    return {
      sessionKey: params.sessionKey,
      target: params.target,
      phase: "idle",
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
    };
  }

  private getOrCreateSession(sessionKey: string, target: TelegramTarget): SessionRuntime {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.target = target;
      return existing;
    }
    const created = this.createSessionState({ sessionKey, target });
    this.sessions.set(sessionKey, created);
    return created;
  }

  private markDirty(session: SessionRuntime): void {
    session.desiredRevision += 1;
    this.scheduleFlush(session.sessionKey);
  }

  private scheduleFlush(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    if (session.renderTimer || session.isFlushing) {
      return;
    }
    const nowMs = Date.now();
    const delayMs = Math.max(0, session.nextAllowedAtMs - nowMs);
    session.renderTimer = setTimeout(() => {
      session.renderTimer = null;
      void this.flushSession(sessionKey);
    }, delayMs);
  }

  private scheduleAutoHide(session: SessionRuntime): void {
    if (this.config.autoHideSeconds <= 0) {
      return;
    }
    if (session.hideTimer) {
      clearTimeout(session.hideTimer);
      session.hideTimer = null;
    }
    session.hideTimer = setTimeout(() => {
      session.hideTimer = null;
      const current = this.sessions.get(session.sessionKey);
      if (!current) {
        return;
      }
      current.phase = "idle";
      current.toolName = null;
      current.error = null;
      this.markDirty(current);
    }, this.config.autoHideSeconds * 1000);
  }

  private async flushSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session || session.isFlushing) {
      return;
    }

    const prefs = this.store.getConversation(session.target);
    if (!prefs.enabled) {
      return;
    }

    if (session.desiredRevision <= session.renderedRevision) {
      return;
    }

    session.isFlushing = true;
    try {
      const text = renderStatusText(session, prefs);
      const controls = this.config.showInlineControls ? buildEnabledControls(prefs) : undefined;
      const controlsKey = JSON.stringify(controls ?? null);

      if (
        text === session.lastRenderedText &&
        controlsKey === session.lastRenderedControlsKey &&
        session.renderedRevision !== 0
      ) {
        session.renderedRevision = session.desiredRevision;
        return;
      }

      const currentRef = this.store.getStatusMessage(session.target);
      let nextRef = currentRef;

      if (currentRef) {
        try {
          nextRef = await this.transport.editStatusMessage({
            target: session.target,
            message: currentRef,
            text,
            buttons: controls,
          });
        } catch (err) {
          if (err instanceof TelegramApiError && err.isEditNotFound()) {
            this.store.setStatusMessage(session.target, null);
            await this.store.persist();
            nextRef = null;
          } else {
            throw err;
          }
        }
      }

      if (!nextRef) {
        nextRef = await this.transport.sendStatusMessage({
          target: session.target,
          text,
          buttons: controls,
        });
      }

      const didMessageRefChange =
        !currentRef ||
        currentRef.messageId !== nextRef.messageId ||
        currentRef.chatId !== nextRef.chatId;
      if (didMessageRefChange) {
        this.store.setStatusMessage(session.target, nextRef);
        await this.store.persist();
      }

      session.lastRenderedText = text;
      session.lastRenderedControlsKey = controlsKey;
      session.lastRenderedAtMs = Date.now();
      session.nextAllowedAtMs =
        session.lastRenderedAtMs + Math.max(this.config.throttleMs, this.config.minThrottleMs);
      session.renderedRevision = session.desiredRevision;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.api.logger.warn(`statusbar render failed: ${message}`);
    } finally {
      session.isFlushing = false;
      if (session.desiredRevision > session.renderedRevision) {
        this.scheduleFlush(session.sessionKey);
      }
    }
  }

  private async onMessageReceived(
    event: { from: string; metadata?: Record<string, unknown> },
    ctx: { channelId: string; accountId?: string; conversationId?: string },
  ): Promise<void> {
    const target = resolveTelegramTargetFromMessageReceived({ event, ctx });
    if (!target) {
      return;
    }

    const sessionKey = resolveSessionKeyFromMessageReceived({
      api: this.api,
      event,
      target,
    });
    this.trackSessionTarget(sessionKey, target);
    this.trackAgentMainAlias(sessionKey, target);
    const senderIdRaw = event.metadata?.senderId;
    this.trackSenderTarget(typeof senderIdRaw === "string" ? senderIdRaw : null, target);

    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    session.phase = "queued";
    session.startedAtMs = Date.now();
    session.endedAtMs = null;
    session.toolName = null;
    session.error = null;
    session.provider = null;
    session.model = null;
    session.usageInput = null;
    session.usageOutput = null;
    session.lastUsageRenderAtMs = 0;
    this.markDirty(session);
  }

  private async onBeforeAgentStart(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on before_agent_start (${sessionKey})`);
      return;
    }

    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    session.phase = "running";
    if (!session.startedAtMs) {
      session.startedAtMs = Date.now();
    }
    session.endedAtMs = null;
    session.error = null;
    session.nextAllowedAtMs = 0;
    this.markDirty(session);
  }

  private async onBeforeToolCall(
    event: { toolName: string },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on before_tool_call (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    session.phase = "tool";
    session.toolName = event.toolName;
    session.nextAllowedAtMs = 0;
    this.markDirty(session);
  }

  private async onAfterToolCall(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on after_tool_call (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    session.phase = "running";
    session.toolName = null;
    session.nextAllowedAtMs = 0;
    this.markDirty(session);
  }

  private async onLlmOutput(
    event: {
      provider: string;
      model: string;
      usage?: {
        input?: number;
        output?: number;
      };
    },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on llm_output (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    session.provider = event.provider;
    session.model = event.model;
    session.usageInput = typeof event.usage?.input === "number" ? Math.trunc(event.usage.input) : 0;
    session.usageOutput =
      typeof event.usage?.output === "number" ? Math.trunc(event.usage.output) : 0;
    if (prefs.mode === "detailed") {
      const nowMs = Date.now();
      const usageIntervalMs = Math.max(this.config.minThrottleMs, this.config.throttleMs, 3000);
      if (nowMs - session.lastUsageRenderAtMs >= usageIntervalMs) {
        session.lastUsageRenderAtMs = nowMs;
        this.markDirty(session);
      }
    }
  }

  private async onAgentEnd(
    event: { success: boolean; error?: string; durationMs?: number },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on agent_end (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) {
      return;
    }

    const session = this.getOrCreateSession(sessionKey, target);
    const nowMs = Date.now();
    if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs > 0) {
      session.startedAtMs = nowMs - Math.trunc(event.durationMs);
    }
    session.endedAtMs = nowMs;
    session.phase = event.success ? "done" : "error";
    session.toolName = null;
    session.error = event.error ?? null;
    session.nextAllowedAtMs = 0;
    this.markDirty(session);
    this.scheduleAutoHide(session);
  }

  private async handleEnableCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return {
        text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbon again.",
      };
    }

    const prefs = this.store.updateConversation(target, (current) => ({
      ...current,
      enabled: true,
    }));
    this.store.setStatusMessage(target, null);
    // OpenClaw can run DM chats on the shared main session (agent:main:main).
    // Keep this alias mapped so lifecycle hooks can always resolve the Telegram target.
    this.trackSessionTarget("agent:main:main", target);
    this.trackSessionTarget(`agent:${target.accountId}:main`, target);
    await this.store.persist();

    const sessionKey = `openclaw-statusbar:manual:${target.accountId}:${target.conversationId}:${target.threadId ?? "main"}`;
    const session = this.getOrCreateSession(sessionKey, target);
    session.phase = "idle";
    session.startedAtMs = Date.now();
    session.endedAtMs = Date.now();
    session.toolName = null;
    session.error = null;
    this.markDirty(session);
    await this.flushSession(sessionKey);
    const ref = this.store.getStatusMessage(target);

    return {
      text: `Statusbar enabled. Mode: ${prefs.mode}\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}\nLive messageId: ${ref?.messageId ?? "pending"}`,
    };
  }

  private async handleDisableCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return {
        text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sboff again.",
      };
    }

    this.store.updateConversation(target, (current) => ({
      ...current,
      enabled: false,
    }));
    await this.store.persist();

    return {
      text: "Statusbar disabled.",
    };
  }

  private parseModeArg(args: string | undefined): StatusMode | null {
    const raw = (args ?? "").trim().toLowerCase();
    if (raw === "minimal" || raw === "normal" || raw === "detailed") {
      return raw;
    }
    return null;
  }

  private async handleModeCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
    args?: string;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return {
        text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbmode again.",
      };
    }

    const nextMode = this.parseModeArg(ctx.args);
    if (!nextMode) {
      const current = this.store.getConversation(target);
      return {
        text: `Current mode: ${current.mode}\nUsage: /sbmode minimal|normal|detailed`,
        channelData: {
          telegram: {
            buttons: buildEnabledControls(current),
          },
        },
      };
    }

    const updated = this.store.updateConversation(target, (current) => ({
      ...current,
      mode: nextMode,
      enabled: true,
    }));
    await this.store.persist();

    for (const session of this.sessions.values()) {
      if (
        session.target.accountId === target.accountId &&
        session.target.conversationId === target.conversationId &&
        session.target.threadId === target.threadId
      ) {
        this.markDirty(session);
      }
    }

    return {
      text: `Mode set: ${updated.mode}\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}`,
    };
  }

  private async handleStatusCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return {
        text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbstatus again.",
      };
    }

    const prefs = this.store.getConversation(target);
    const ref = this.store.getStatusMessage(target);
    const lines = [
      `Statusbar mapping`,
      `account=${target.accountId}`,
      `conversation=${target.conversationId}`,
      `chat=${target.chatId}`,
      `thread=${target.threadId ?? "main"}`,
      `enabled=${prefs.enabled}`,
      `mode=${prefs.mode}`,
      `messageId=${ref?.messageId ?? "none"}`,
      `messageChat=${ref?.chatId ?? "none"}`,
      `note=only this messageId is live-updated`,
    ];
    return { text: lines.join("\n") };
  }

  private async handleResetCommand(ctx: {
    channel: string;
    senderId?: string;
    accountId?: string;
    to?: string;
    from?: string;
    messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return {
        text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbreset again.",
      };
    }

    const prefs = this.store.getConversation(target);
    this.store.setStatusMessage(target, null);
    await this.store.persist();

    if (prefs.enabled) {
      const sessionKey = `openclaw-statusbar:reset:${target.accountId}:${target.conversationId}:${target.threadId ?? "main"}`;
      const session = this.getOrCreateSession(sessionKey, target);
      session.phase = "idle";
      session.startedAtMs = Date.now();
      session.endedAtMs = Date.now();
      session.toolName = null;
      session.error = null;
      this.markDirty(session);
      await this.flushSession(sessionKey);
    }

    const ref = this.store.getStatusMessage(target);

    return {
      text: `Statusbar message reference reset.\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}\nLive messageId: ${ref?.messageId ?? "pending"}`,
    };
  }
}

export default {
  id: "openclaw-statusbar",
  name: "Statusbar",
  description: "Telegram statusline for OpenClaw agent runs",
  register(api: OpenClawPluginApi) {
    const runtime = new StatusbarRuntime(api);
    void runtime
      .init()
      .then(() => {
        api.logger.info("openclaw-statusbar plugin initialized");
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`openclaw-statusbar init failed: ${message}`);
      });
  },
};
