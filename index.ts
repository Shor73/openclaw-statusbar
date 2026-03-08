import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import { normalizePluginConfig } from "./src/config.js";
import {
  resolveSessionKeyFromMessageReceived,
  resolveTelegramTargetFromCommandContext,
  resolveTelegramTargetFromMessageReceived,
  resolveTelegramTargetFromSessionKey,
} from "./src/resolver.js";
import { renderStatusText, renderStatusButtons } from "./src/render.js";
import { StatusbarStore } from "./src/store.js";
import { TelegramApiError, TelegramTransport } from "./src/transport.js";
import { SharedState, makeDefaultSharedState } from "./src/shared-state.js";
import type {
  RunPhase,
  SessionRuntime,
  StatusMode,
  StatusbarPluginConfig,
  TelegramTarget,
} from "./src/types.js";

const RE_COMMAND = /^\/[a-z0-9_]+(?:\s|$)/i;
const RE_AGENT_ID = /^agent:([^:]+):/;
const RE_AGENT_MAIN = /^agent:([^:]+):main$/;

const ACTIVE_PHASES = new Set<RunPhase>(["queued", "running", "thinking", "tool"]);
const STALE_WRITER_MS = 5_000; // if writer hasn't updated in 5s, another instance can render

type SessionTargetRef = { target: TelegramTarget; seenAtMs: number };
type SenderTargetRef = { target: TelegramTarget; seenAtMs: number };

const SESSION_TARGET_TTL_MS = 30 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────────────
// Local render state — per-instance, NOT shared. Controls throttling & timers.
// ────────────────────────────────────────────────────────────────────────────
type LocalRenderState = {
  target: TelegramTarget;
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
  /** Tool durations for ETA — accumulated during this run */
  toolDurationsRaw: Map<string, number[]>;
};

class StatusbarRuntime {
  private readonly api: OpenClawPluginApi;
  private readonly config: StatusbarPluginConfig;
  private readonly store: StatusbarStore;
  private readonly transport: TelegramTransport;
  private readonly shared: SharedState;
  // Both [gateway] and [plugins] instances run in the SAME process (same PID).
  // Use PID-only so canRender() treats them as the same writer.
  private readonly instanceId = `${process.pid}`;

  // Local render states — keyed by runtimeSessionKey (chat|chatId|threadId)
  private readonly renderStates = new Map<string, LocalRenderState>();

  // Target resolution caches
  private readonly sessionTargets = new Map<string, SessionTargetRef>();
  private readonly senderTargets = new Map<string, SenderTargetRef>();
  private liveTicker: ReturnType<typeof setInterval> | null = null;
  private lastPruneMs = 0;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.config = normalizePluginConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    this.store = new StatusbarStore({
      stateDir,
      enabledByDefault: this.config.enabledByDefault,
      defaultMode: this.config.defaultMode,
      defaultLayout: this.config.defaultLayout,
      defaultProgressMode: this.config.defaultProgressMode,
      log: (msg) => this.api.logger.warn(msg),
    });
    this.transport = new TelegramTransport({ api, config: this.config });
    this.shared = new SharedState();
  }

  async init(): Promise<void> {
    await this.store.load();
    // Clear stale shared state from previous gateway run
    this.shared.clear();
    // Cleanup stale Telegram messages
    this.cleanupStaleMessages().catch(() => {});
    this.startLiveTicker();

    // Commands
    this.api.registerCommand({ name: "sbon", description: "Enable statusline", acceptsArgs: false, handler: (ctx) => this.handleEnableCommand(ctx) });
    this.api.registerCommand({ name: "sboff", description: "Disable statusline", acceptsArgs: false, handler: (ctx) => this.handleDisableCommand(ctx) });
    this.api.registerCommand({ name: "sbmode", description: "Set mode: minimal|normal|detailed", acceptsArgs: true, handler: (ctx) => this.handleModeCommand(ctx) });
    this.api.registerCommand({ name: "sbstatus", description: "Show statusbar info", acceptsArgs: false, handler: (ctx) => this.handleStatusCommand(ctx) });
    this.api.registerCommand({ name: "sbreset", description: "Reset statusbar message", acceptsArgs: false, handler: (ctx) => this.handleResetCommand(ctx) });
    this.api.registerCommand({ name: "sbpin", description: "Pin statusline", acceptsArgs: false, handler: (ctx) => this.handlePinCommand(ctx) });
    this.api.registerCommand({ name: "sbunpin", description: "Unpin statusline", acceptsArgs: false, handler: (ctx) => this.handleUnpinCommand(ctx) });
    this.api.registerCommand({ name: "sbsettings", description: "Show settings", acceptsArgs: false, handler: (ctx) => this.handleSettingsCommand(ctx) });
    this.api.registerCommand({ name: "sbbuttons", description: "Toggle inline buttons", acceptsArgs: false, handler: (ctx) => this.handleButtonsCommand(ctx) });

    // Hooks
    this.api.on("message_received", async (event, ctx) => this.onMessageReceived(event, ctx));
    this.api.on("before_agent_start", async (_event, ctx) => this.onBeforeAgentStart(ctx));
    this.api.on("before_tool_call", async (event, ctx) => this.onBeforeToolCall(event, ctx));
    this.api.on("after_tool_call", async (event, ctx) => this.onAfterToolCall(event, ctx));
    this.api.on("llm_input", async (event, ctx) => this.onLlmInput(event, ctx));
    this.api.on("llm_output", async (event, ctx) => this.onLlmOutput(event, ctx));
    this.api.on("agent_end", async (event, ctx) => this.onAgentEnd(event, ctx));
    this.api.on("message_sent", async (event, ctx) => this.onMessageSent(event, ctx));
    this.api.on("before_compaction", async (_event, ctx) => this.onBeforeCompaction(ctx));
    this.api.on("after_compaction", async (_event, ctx) => this.onAfterCompaction(ctx));
    this.api.on("before_prompt_build", (_event, ctx) => this.onBeforePromptBuild(ctx));
  }

  destroy(): void {
    if (this.liveTicker) {
      clearInterval(this.liveTicker);
      this.liveTicker = null;
    }
    for (const rs of this.renderStates.values()) {
      if (rs.renderTimer) clearTimeout(rs.renderTimer);
      if (rs.hideTimer) clearTimeout(rs.hideTimer);
      if (rs.maxRunTimer) clearTimeout(rs.maxRunTimer);
    }
    this.renderStates.clear();
    this.store.flushPersist();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Target resolution (unchanged logic, cleaned up)
  // ──────────────────────────────────────────────────────────────────────────

  private runtimeKey(target: TelegramTarget): string {
    return `chat|${target.chatId}|${target.threadId ?? "main"}`;
  }

  private trackSessionTarget(sessionKey: string, target: TelegramTarget): void {
    this.sessionTargets.set(sessionKey, { target, seenAtMs: Date.now() });
  }

  private trackAgentMainAlias(sessionKey: string, target: TelegramTarget): void {
    const match = RE_AGENT_ID.exec(sessionKey);
    const agentId = match?.[1]?.trim() || "main";
    this.trackSessionTarget(`agent:${agentId}:main`, target);
  }

  private trackSenderTarget(senderId: string | null, target: TelegramTarget): void {
    const sender = (senderId ?? "").trim();
    if (!sender) return;
    this.senderTargets.set(`${target.accountId}::${sender}`, { target, seenAtMs: Date.now() });
  }

  private resolveTargetFromSender(params: { senderId?: string; accountId?: string }): TelegramTarget | null {
    const sender = (params.senderId ?? "").trim();
    if (!sender) return null;
    const preferredAccountId = (params.accountId ?? "").trim();
    if (preferredAccountId) {
      const direct = this.senderTargets.get(`${preferredAccountId}::${sender}`);
      if (direct) { direct.seenAtMs = Date.now(); return direct.target; }
    }
    let best: SenderTargetRef | null = null;
    const suffix = `::${sender}`;
    for (const [key, entry] of this.senderTargets.entries()) {
      if (!key.endsWith(suffix)) continue;
      if (!best || entry.seenAtMs > best.seenAtMs) best = entry;
    }
    if (!best) return null;
    best.seenAtMs = Date.now();
    return best.target;
  }

  private resolveTargetForSession(sessionKey: string | undefined | null): TelegramTarget | null {
    const key = (sessionKey ?? "").trim();
    if (!key) return null;
    const tracked = this.sessionTargets.get(key);
    if (tracked) { tracked.seenAtMs = Date.now(); return tracked.target; }
    const fromKey = resolveTelegramTargetFromSessionKey(key);
    if (fromKey) {
      // Fix: session key "agent:main:telegram:direct:25017841" is parsed as legacy format
      // with accountId="default". Extract actual agentId from the key and use it as accountId.
      if (fromKey.accountId === "default") {
        const agentMatch = RE_AGENT_ID.exec(key);
        if (agentMatch?.[1]) {
          fromKey.accountId = agentMatch[1].trim();
          fromKey.conversationId = `telegram:${fromKey.chatId}`;
        }
      }
      // Also try to align with an already-tracked target for this chatId
      for (const [, entry] of this.sessionTargets) {
        if (entry.target.chatId === fromKey.chatId && entry.target.threadId === fromKey.threadId) {
          fromKey.accountId = entry.target.accountId;
          fromKey.conversationId = entry.target.conversationId;
          break;
        }
      }
      this.trackSessionTarget(key, fromKey);
      return fromKey;
    }
    const mainMatch = RE_AGENT_MAIN.exec(key);
    if (mainMatch?.[1]) {
      const fromStore = this.store.findMostRecentTargetForAccount(mainMatch[1].trim());
      if (fromStore) { this.trackSessionTarget(key, fromStore); return fromStore; }
    }
    return null;
  }

  private resolveTargetForCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): TelegramTarget | null {
    const direct = resolveTelegramTargetFromCommandContext(ctx);
    if (direct) return direct;
    if ((ctx.channel ?? "").trim().toLowerCase() !== "telegram") return null;
    return this.resolveTargetFromSender({ senderId: ctx.senderId, accountId: ctx.accountId });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Render state management
  // ──────────────────────────────────────────────────────────────────────────

  private getOrCreateRenderState(target: TelegramTarget): LocalRenderState {
    const key = this.runtimeKey(target);
    let rs = this.renderStates.get(key);
    if (!rs) {
      rs = {
        target,
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
        toolDurationsRaw: new Map(),
      };
      this.renderStates.set(key, rs);
    }
    rs.target = target; // keep target fresh
    return rs;
  }

  /** Build a SessionRuntime for render.ts from shared state + local render state */
  private buildSessionForRender(key: string, target: TelegramTarget): SessionRuntime {
    const shared = this.shared.get(key);
    const s = shared ?? makeDefaultSharedState(this.instanceId);
    return {
      sessionKey: key,
      target,
      phase: s.phase,
      runNumber: s.runNumber,
      queuedCount: s.queuedCount,
      currentRunSteps: s.steps,
      startedAtMs: s.startedAtMs,
      endedAtMs: s.endedAtMs,
      toolName: s.toolName,
      provider: s.provider,
      model: s.model,
      usageInput: s.usageInput,
      usageOutput: s.usageOutput,
      lastUsageRenderAtMs: 0,
      error: s.error,
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
      wasLockOwner: false,
      currentRunId: null,
      isThinkingRun: false,
      predictedSteps: s.predictedSteps,
      toolDurationsRaw: new Map(),
      thinkingLevel: s.thinkingLevel,
      lastHookAtMs: s.updatedAtMs,
      compacting: s.compacting,
      llmFinishedAtMs: null,
    };
  }

  /** Can this instance render for the given shared state? */
  private canRender(shared: { writerInstanceId: string; updatedAtMs: number } | null): boolean {
    if (!shared) return true;
    if (shared.writerInstanceId === this.instanceId) return true;
    // Stale writer — take over rendering
    return Date.now() - shared.updatedAtMs > STALE_WRITER_MS;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Dirty / flush / render pipeline
  // ──────────────────────────────────────────────────────────────────────────

  private markDirty(key: string, urgent = false): void {
    const rs = this.renderStates.get(key);
    if (!rs) return;
    rs.desiredRevision += 1;
    if (urgent) {
      rs.nextAllowedAtMs = 0;
      if (rs.renderTimer) { clearTimeout(rs.renderTimer); rs.renderTimer = null; }
    }
    this.scheduleFlush(key);
  }

  private scheduleFlush(key: string): void {
    const rs = this.renderStates.get(key);
    if (!rs || rs.renderTimer || rs.isFlushing) return;
    const delayMs = Math.max(0, rs.nextAllowedAtMs - Date.now());
    rs.renderTimer = setTimeout(() => {
      rs.renderTimer = null;
      void this.flush(key);
    }, delayMs);
  }

  private resolveThrottleMs(phase: RunPhase): number {
    switch (phase) {
      case "tool": return Math.max(this.config.minThrottleMs, 2000);
      case "queued": return this.config.throttleMs * 2;
      default: return this.config.throttleMs;
    }
  }

  private async flush(key: string): Promise<void> {
    const rs = this.renderStates.get(key);
    if (!rs || rs.isFlushing) return;

    const shared = this.shared.get(key);
    if (!shared) return;
    if (shared.compacting) return;
    if (!this.canRender(shared)) return;

    const prefs = this.store.getConversation(rs.target);
    if (!prefs.enabled) return;
    if (rs.desiredRevision <= rs.renderedRevision) return;
    if (!this.transport.canProceed(rs.target.accountId, rs.target.chatId)) return;

    rs.isFlushing = true;
    try {
      const session = this.buildSessionForRender(key, rs.target);
      const text = renderStatusText(session, prefs);
      const controls = renderStatusButtons(session, prefs);
      const controlsKey = JSON.stringify(controls ?? null);

      // Skip if nothing changed
      if (text === rs.lastRenderedText && controlsKey === rs.lastRenderedControlsKey && rs.renderedRevision !== 0) {
        rs.renderedRevision = rs.desiredRevision;
        return;
      }

      const currentRef = this.store.getStatusMessage(rs.target);
      let nextRef = currentRef;

      if (currentRef) {
        try {
          nextRef = await this.transport.editStatusMessage({ target: rs.target, message: currentRef, text, buttons: controls });
        } catch (err) {
          if (err instanceof TelegramApiError && err.isEditNotFound()) {
            this.store.setStatusMessage(rs.target, null);
            this.store.schedulePersist();
            nextRef = null;
          } else if (err instanceof TelegramApiError && err.isRateLimit()) {
            const remainingMs = this.transport.rateLimiterRemainingMs(rs.target.accountId, rs.target.chatId);
            rs.nextAllowedAtMs = Date.now() + Math.max(remainingMs, this.config.throttleMs);
            return;
          } else {
            throw err;
          }
        }
      }

      if (!nextRef) {
        if (prefs.enabled) {
          nextRef = await this.transport.sendStatusMessage({ target: rs.target, text, buttons: controls });
        } else {
          rs.renderedRevision = rs.desiredRevision;
          return;
        }
      }

      const didChange = !currentRef || currentRef.messageId !== nextRef.messageId || currentRef.chatId !== nextRef.chatId;
      if (didChange) {
        this.store.setStatusMessage(rs.target, nextRef);
        await this.store.persist();
        if (prefs.pinMode) {
          try { await this.transport.pinStatusMessage({ target: rs.target, message: nextRef }); }
          catch (err) { this.api.logger.warn(`statusbar pin failed: ${err instanceof Error ? err.message : String(err)}`); }
        }
      }

      rs.lastRenderedText = text;
      rs.lastRenderedControlsKey = controlsKey;
      rs.lastRenderedAtMs = Date.now();
      rs.nextAllowedAtMs = rs.lastRenderedAtMs + Math.max(this.resolveThrottleMs(shared.phase), this.config.minThrottleMs);
      rs.renderedRevision = rs.desiredRevision;
    } catch (err) {
      this.api.logger.warn(`statusbar render failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rs.isFlushing = false;
      if (rs.desiredRevision > rs.renderedRevision) this.scheduleFlush(key);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Live ticker
  // ──────────────────────────────────────────────────────────────────────────

  private startLiveTicker(): void {
    if (this.liveTicker) clearInterval(this.liveTicker);
    const tickMs = Math.max(250, this.config.liveTickMs);
    this.liveTicker = setInterval(() => this.onLiveTick(), tickMs);
    this.liveTicker.unref?.();
  }

  private onLiveTick(): void {
    const now = Date.now();
    const cadenceMs = Math.max(this.config.liveTickMs, this.config.minThrottleMs);
    const allShared = this.shared.read();

    for (const [key, shared] of Object.entries(allShared)) {
      if (!ACTIVE_PHASES.has(shared.phase)) continue;
      if (!this.canRender(shared)) continue;

      const rs = this.renderStates.get(key);
      if (!rs) continue;
      if (now - rs.lastRenderedAtMs < cadenceMs) continue;
      if (!this.store.getConversation(rs.target).enabled) continue;

      this.markDirty(key);
    }

    // Prune stale target caches
    if (now - this.lastPruneMs > PRUNE_INTERVAL_MS) {
      this.lastPruneMs = now;
      for (const [k, e] of this.sessionTargets.entries()) {
        if (now - e.seenAtMs > SESSION_TARGET_TTL_MS) this.sessionTargets.delete(k);
      }
      for (const [k, e] of this.senderTargets.entries()) {
        if (now - e.seenAtMs > SESSION_TARGET_TTL_MS) this.senderTargets.delete(k);
      }
    }

    // Prune old shared state entries (2h)
    this.shared.prune(2 * 60 * 60 * 1000);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stale message cleanup (on startup)
  // ──────────────────────────────────────────────────────────────────────────

  private async cleanupStaleMessages(): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 4000));
    const targets = this.store.getAllTargets();
    for (const target of targets) {
      try {
        const ref = this.store.getStatusMessage(target);
        if (!ref) continue;
        const prefs = this.store.getConversation(target);
        if (!prefs.enabled) continue;
        if (prefs.pinMode) continue; // pinned messages keep last state
        const session = this.buildSessionForRender(this.runtimeKey(target), target);
        session.phase = "idle";
        const text = renderStatusText(session, prefs);
        await this.transport.editStatusMessage({ target, message: ref, text, buttons: undefined });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/message to edit not found/i.test(msg)) {
          this.store.setStatusMessage(target, null);
          this.store.schedulePersist();
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Auto-hide
  // ──────────────────────────────────────────────────────────────────────────

  private scheduleAutoHide(key: string): void {
    if (this.config.autoHideSeconds <= 0) return;
    const rs = this.renderStates.get(key);
    if (!rs) return;
    if (rs.hideTimer) { clearTimeout(rs.hideTimer); rs.hideTimer = null; }
    rs.hideTimer = setTimeout(() => {
      rs.hideTimer = null;
      this.shared.update(key, (s) => s ? { ...s, phase: "idle", toolName: null, error: null, steps: 0, writerInstanceId: this.instanceId, updatedAtMs: Date.now() } : null);
      this.markDirty(key);
    }, this.config.autoHideSeconds * 1000);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: message_received
  // ──────────────────────────────────────────────────────────────────────────

  private async onMessageReceived(
    event: { from: string; content?: string; metadata?: Record<string, unknown> },
    ctx: { channelId: string; accountId?: string; conversationId?: string },
  ): Promise<void> {
    const target = resolveTelegramTargetFromMessageReceived({ event, ctx });
    if (!target) return;

    const sessionKey = resolveSessionKeyFromMessageReceived({ api: this.api, event, target });
    this.trackSessionTarget(sessionKey, target);
    this.trackAgentMainAlias(sessionKey, target);
    const senderIdRaw = event.metadata?.senderId;
    this.trackSenderTarget(typeof senderIdRaw === "string" ? senderIdRaw : null, target);

    if (RE_COMMAND.test((event.content ?? "").trim())) return;

    const prefs = this.store.getConversation(target);
    this.api.logger.debug?.(`statusbar: message_received target=${target.chatId} enabled=${prefs.enabled}`);
    if (!prefs.enabled) return;

    const key = this.runtimeKey(target);
    const rs = this.getOrCreateRenderState(target);

    // Check if there's already an active run
    const existing = this.shared.get(key);
    const isActive = existing && ACTIVE_PHASES.has(existing.phase);

    if (!isActive) {
      // New run — prepare fresh message if not pinned
      const shouldNewMsg = this.config.newMessagePerRun && !prefs.pinMode;
      if (shouldNewMsg) {
        this.store.setStatusMessage(target, null);
        this.store.schedulePersist();
        rs.lastRenderedText = null;
        rs.lastRenderedControlsKey = null;
        rs.renderedRevision = 0;
      }
    }

    this.shared.update(key, (s) => {
      const base = s ?? makeDefaultSharedState(this.instanceId);
      const wasActive = ACTIVE_PHASES.has(base.phase);
      return {
        ...base,
        phase: wasActive ? base.phase : "queued",
        startedAtMs: wasActive ? base.startedAtMs : Date.now(),
        endedAtMs: wasActive ? base.endedAtMs : null,
        steps: wasActive ? base.steps : 0,
        toolName: wasActive ? base.toolName : null,
        error: wasActive ? base.error : null,
        queuedCount: Math.max(0, base.queuedCount) + 1,
        writerInstanceId: this.instanceId,
        updatedAtMs: Date.now(),
      };
    });

    this.markDirty(key, true);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: before_agent_start
  // ──────────────────────────────────────────────────────────────────────────

  private async onBeforeAgentStart(ctx: { sessionKey?: string; thinkingLevel?: string; reasoning?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const key = this.runtimeKey(target);
    const rs = this.getOrCreateRenderState(target);

    // If previous run is in a REAL active phase (not queued), handle it
    const existing = this.shared.get(key);
    if (existing && (existing.phase === "running" || existing.phase === "thinking" || existing.phase === "tool")) {
      const age = Date.now() - existing.startedAtMs;
      if (age > 2000) {
        // Previous run ended silently — force "done" then start new
        this.shared.update(key, (s) => s ? { ...s, phase: "done", endedAtMs: Date.now(), writerInstanceId: this.instanceId, updatedAtMs: Date.now() } : null);
        this.markDirty(key, true);
        await this.flush(key);
      } else {
        // Double-fire within 2s — same turn, skip
        return;
      }
    }
    // "queued", "idle", "done", "error", "sending" → proceed normally to start new run

    // Clear all timers for fresh start
    if (rs.hideTimer) { clearTimeout(rs.hideTimer); rs.hideTimer = null; }
    if (rs.renderTimer) { clearTimeout(rs.renderTimer); rs.renderTimer = null; }
    if (rs.maxRunTimer) { clearTimeout(rs.maxRunTimer); rs.maxRunTimer = null; }
    rs.isFlushing = false;
    rs.nextAllowedAtMs = 0;
    rs.toolDurationsRaw = new Map();

    const thinkingRaw = ctx.thinkingLevel ?? ctx.reasoning;

    // Write new run to shared state
    this.shared.update(key, (s) => ({
      ...(s ?? makeDefaultSharedState(this.instanceId)),
      phase: "running" as RunPhase,
      startedAtMs: Date.now(),
      endedAtMs: null,
      steps: 0,
      predictedSteps: prefs.historyRuns > 0 ? Math.round(Math.max(1, prefs.avgSteps)) : 0,
      toolName: null,
      error: null,
      model: null,
      provider: null,
      usageInput: null,
      usageOutput: null,
      thinkingLevel: typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : (s?.thinkingLevel ?? null),
      runNumber: ((s?.runNumber ?? 0) + 1),
      queuedCount: Math.max(0, (s?.queuedCount ?? 1) - 1),
      compacting: false,
      writerInstanceId: this.instanceId,
      updatedAtMs: Date.now(),
    }));

    // Safety net: force "done" after 90s
    rs.maxRunTimer = setTimeout(() => {
      rs.maxRunTimer = null;
      const current = this.shared.get(key);
      if (current && ACTIVE_PHASES.has(current.phase)) {
        this.api.logger.warn(`statusbar: maxRunTimer fired (90s), forcing done`);
        this.shared.update(key, (s) => s ? { ...s, phase: "done", endedAtMs: Date.now(), writerInstanceId: this.instanceId, updatedAtMs: Date.now() } : null);
        this.markDirty(key, true);
      }
    }, 90_000);

    this.markDirty(key, true);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: before_tool_call
  // ──────────────────────────────────────────────────────────────────────────

  private async onBeforeToolCall(
    event: { toolName: string },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    if (!this.store.getConversation(target).enabled) return;
    this.getOrCreateRenderState(target);

    this.shared.update(key, (s) => {
      if (!s) return null;
      const newSteps = s.steps + 1;
      return {
        ...s,
        phase: "tool" as RunPhase,
        toolName: event.toolName,
        steps: newSteps,
        predictedSteps: Math.max(s.predictedSteps, newSteps),
        writerInstanceId: this.instanceId,
        updatedAtMs: Date.now(),
      };
    });
    this.markDirty(key, true);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: after_tool_call
  // ──────────────────────────────────────────────────────────────────────────

  private async onAfterToolCall(
    event: { toolName: string; durationMs?: number },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    if (!this.store.getConversation(target).enabled) return;

    const rs = this.getOrCreateRenderState(target);
    this.shared.update(key, (s) => s ? { ...s, phase: "running" as RunPhase, toolName: null, writerInstanceId: this.instanceId, updatedAtMs: Date.now() } : null);

    // Track tool duration for ETA
    if (typeof event.durationMs === "number" && event.durationMs > 0) {
      const toolKey = event.toolName ?? "unknown";
      const samples = rs.toolDurationsRaw.get(toolKey) ?? [];
      samples.push(event.durationMs);
      if (samples.length > 20) samples.shift();
      rs.toolDurationsRaw.set(toolKey, samples);
      if (rs.toolDurationsRaw.size > 50) {
        let minKey = ""; let minCount = Infinity;
        for (const [k, v] of rs.toolDurationsRaw) { if (v.length < minCount) { minCount = v.length; minKey = k; } }
        if (minKey) rs.toolDurationsRaw.delete(minKey);
      }
    }
    this.markDirty(key);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: llm_input
  // ──────────────────────────────────────────────────────────────────────────

  private async onLlmInput(
    event: { runId: string; provider: string; model: string },
    ctx: { sessionKey?: string; thinkingLevel?: string; reasoning?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    if (!this.store.getConversation(target).enabled) return;
    this.getOrCreateRenderState(target);

    const thinkingRaw = ctx.thinkingLevel ?? ctx.reasoning;

    this.shared.update(key, (s) => {
      if (!s) return null;
      return {
        ...s,
        phase: s.phase === "running" ? "thinking" as RunPhase : s.phase,
        thinkingLevel: typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : s.thinkingLevel,
        writerInstanceId: this.instanceId,
        updatedAtMs: Date.now(),
      };
    });
    this.markDirty(key);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: llm_output
  // ──────────────────────────────────────────────────────────────────────────

  private async onLlmOutput(
    event: { provider: string; model: string; usage?: { input?: number; output?: number } },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;
    this.getOrCreateRenderState(target);

    const newInput = typeof event.usage?.input === "number" ? Math.trunc(event.usage.input) : 0;
    const newOutput = typeof event.usage?.output === "number" ? Math.trunc(event.usage.output) : 0;

    // Parse tool_use count from assistantTexts for predicted steps
    const assistantTexts = (event as { assistantTexts?: unknown[] }).assistantTexts;
    let extraPredicted = 0;
    if (Array.isArray(assistantTexts)) {
      const allText = assistantTexts.map(t => typeof t === "string" ? t : JSON.stringify(t)).join("");
      const matches = allText.match(/"type"\s*:\s*"tool_use"/g);
      extraPredicted = matches?.length ?? 0;
    }

    const isFirstModel = !this.shared.get(key)?.model && event.model;

    this.shared.update(key, (s) => {
      if (!s) return null;
      const newPredicted = extraPredicted > 0 ? Math.max(s.predictedSteps, s.steps + extraPredicted) : s.predictedSteps;
      return {
        ...s,
        provider: event.provider,
        model: event.model,
        usageInput: (s.usageInput ?? 0) + newInput,
        usageOutput: (s.usageOutput ?? 0) + newOutput,
        predictedSteps: newPredicted,
        writerInstanceId: this.instanceId,
        updatedAtMs: Date.now(),
      };
    });

    this.markDirty(key, !!isFirstModel);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: agent_end
  // ──────────────────────────────────────────────────────────────────────────

  private async onAgentEnd(
    event: { success: boolean; error?: string; durationMs?: number },
    ctx: { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const key = this.runtimeKey(target);
    const rs = this.getOrCreateRenderState(target);

    const nowMs = Date.now();
    if (rs.maxRunTimer) { clearTimeout(rs.maxRunTimer); rs.maxRunTimer = null; }

    const nextPhase: RunPhase = event.success ? "done" : "error";

    this.shared.update(key, (s) => {
      if (!s) return null;
      let startMs = s.startedAtMs;
      if (typeof event.durationMs === "number" && event.durationMs > 0) {
        startMs = nowMs - Math.trunc(event.durationMs);
      }
      return {
        ...s,
        phase: nextPhase,
        startedAtMs: startMs,
        endedAtMs: nowMs,
        toolName: null,
        error: event.error ?? null,
        writerInstanceId: this.instanceId,
        updatedAtMs: nowMs,
      };
    });

    // Update conversation stats on success
    if (event.success) {
      const shared = this.shared.get(key);
      const durationMs = shared ? Math.max(1000, (shared.endedAtMs ?? nowMs) - shared.startedAtMs) : 1000;
      const completedSteps = shared ? Math.max(1, shared.steps) : 1;
      const toolSamples = rs.toolDurationsRaw;

      this.store.updateConversation(target, (current) => {
        const n = Math.max(0, current.historyRuns);
        const nextRuns = n + 1;
        const nextAvgDurationMs = n === 0 ? durationMs : Math.round((current.avgDurationMs * n + durationMs) / nextRuns);
        const nextAvgSteps = n === 0 ? completedSteps : (current.avgSteps * n + completedSteps) / nextRuns;

        const nextToolAvg = { ...current.toolAvgDurations };
        let totalDuration = 0; let totalCount = 0;
        for (const [toolName, samples] of toolSamples.entries()) {
          if (samples.length === 0) continue;
          const sampleAvg = samples.reduce((a, b) => a + b, 0) / samples.length;
          totalDuration += sampleAvg; totalCount += 1;
          const prev = nextToolAvg[toolName];
          nextToolAvg[toolName] = prev == null ? sampleAvg : Math.round(prev * 0.7 + sampleAvg * 0.3);
        }
        if (totalCount > 0) {
          const globalAvg = totalDuration / totalCount;
          const prevGlobal = nextToolAvg["_global"];
          nextToolAvg["_global"] = prevGlobal == null ? Math.round(globalAvg) : Math.round(prevGlobal * 0.7 + globalAvg * 0.3);
        }

        return {
          ...current,
          historyRuns: nextRuns,
          avgDurationMs: nextAvgDurationMs,
          avgSteps: Number.isFinite(nextAvgSteps) ? nextAvgSteps : completedSteps,
          toolAvgDurations: nextToolAvg,
        };
      });
      this.store.schedulePersist();
    }

    // Clear render timer for immediate flush
    if (rs.renderTimer) { clearTimeout(rs.renderTimer); rs.renderTimer = null; }
    this.markDirty(key, true);

    const shared = this.shared.get(key);
    if (!shared || shared.queuedCount <= 0) {
      this.scheduleAutoHide(key);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: message_sent — cross-instance "done" signal
  // ──────────────────────────────────────────────────────────────────────────

  private async onMessageSent(
    event: { success: boolean },
    ctx: { channelId: string; accountId?: string; conversationId?: string },
  ): Promise<void> {
    if (!event.success) return;
    if ((ctx.channelId ?? "").toLowerCase() !== "telegram") return;

    const target = resolveTelegramTargetFromCommandContext({
      channel: ctx.channelId,
      accountId: ctx.accountId,
      to: ctx.conversationId,
    });
    if (!target) return;

    const key = this.runtimeKey(target);
    const shared = this.shared.get(key);
    if (!shared) return;

    this.getOrCreateRenderState(target);

    // If phase is still active → run ended, message delivered → done
    if (ACTIVE_PHASES.has(shared.phase) || shared.phase === "sending") {
      this.shared.update(key, (s) => s ? {
        ...s,
        phase: "done" as RunPhase,
        endedAtMs: Date.now(),
        writerInstanceId: this.instanceId,
        updatedAtMs: Date.now(),
      } : null);
      this.markDirty(key, true);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: compaction
  // ──────────────────────────────────────────────────────────────────────────

  private async onBeforeCompaction(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    this.shared.update(key, (s) => s ? { ...s, compacting: true, updatedAtMs: Date.now() } : null);
  }

  private async onAfterCompaction(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const key = this.runtimeKey(target);
    this.shared.update(key, (s) => s ? { ...s, compacting: false, writerInstanceId: this.instanceId, updatedAtMs: Date.now() } : null);
    this.markDirty(key, true);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hook: before_prompt_build
  // ──────────────────────────────────────────────────────────────────────────

  private onBeforePromptBuild(ctx: { sessionKey?: string }): { appendSystemContext: string } | void {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;
    return {
      appendSystemContext:
        "Statusbar is active. Commands: /sbon /sboff /sbmode [minimal|normal|detailed] /sbpin /sbunpin /sbstatus /sbreset /sbbuttons /sbsettings",
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Command handlers
  // ──────────────────────────────────────────────────────────────────────────

  private async handleEnableCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat. Send a message first, then /sbon." };

    const prefs = this.store.updateConversation(target, (c) => ({ ...c, enabled: true }));
    this.store.setStatusMessage(target, null);
    this.trackSessionTarget("agent:main:main", target);
    this.trackSessionTarget(`agent:${target.accountId}:main`, target);
    this.store.schedulePersist();

    const key = this.runtimeKey(target);
    this.getOrCreateRenderState(target);
    this.shared.set(key, { ...makeDefaultSharedState(this.instanceId), phase: "idle" });
    this.markDirty(key);
    await this.flush(key);
    const ref = this.store.getStatusMessage(target);

    return { text: `Statusbar enabled. Mode: ${prefs.mode}\nTarget: account=${target.accountId} chat=${target.chatId}\nLive messageId: ${ref?.messageId ?? "pending"}` };
  }

  private async handleDisableCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    this.store.updateConversation(target, (c) => ({ ...c, enabled: false }));
    this.store.schedulePersist();
    return { text: "Statusbar disabled." };
  }

  private parseModeArg(args: string | undefined): StatusMode | null {
    const raw = (args ?? "").trim().toLowerCase();
    if (raw === "minimal" || raw === "normal" || raw === "detailed") return raw;
    return null;
  }

  private async handleModeCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number; args?: string;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    const nextMode = this.parseModeArg(ctx.args);
    if (!nextMode) {
      const current = this.store.getConversation(target);
      return { text: `Current mode: ${current.mode}\nUsage: /sbmode minimal|normal|detailed` };
    }
    const updated = this.store.updateConversation(target, (c) => ({ ...c, mode: nextMode, enabled: true }));
    this.store.schedulePersist();
    const key = this.runtimeKey(target);
    this.markDirty(key);
    return { text: `Mode set: ${updated.mode}` };
  }

  private async handleStatusCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    const prefs = this.store.getConversation(target);
    const ref = this.store.getStatusMessage(target);
    const key = this.runtimeKey(target);
    const shared = this.shared.get(key);
    return {
      text: [
        "Statusbar mapping",
        `account=${target.accountId} chat=${target.chatId}`,
        `enabled=${prefs.enabled} mode=${prefs.mode} pin=${prefs.pinMode}`,
        `phase=${shared?.phase ?? "none"} steps=${shared?.steps ?? 0}`,
        `historyRuns=${prefs.historyRuns} avgSteps=${prefs.avgSteps.toFixed(1)}`,
        `messageId=${ref?.messageId ?? "none"}`,
        `instanceId=${this.instanceId}`,
        `writer=${shared?.writerInstanceId ?? "none"}`,
      ].join("\n"),
    };
  }

  private async handleResetCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    this.store.setStatusMessage(target, null);
    this.store.schedulePersist();
    const prefs = this.store.getConversation(target);
    if (prefs.enabled) {
      const key = this.runtimeKey(target);
      this.getOrCreateRenderState(target);
      this.shared.set(key, { ...makeDefaultSharedState(this.instanceId), phase: "idle" });
      const rs = this.renderStates.get(key);
      if (rs) { rs.lastRenderedText = null; rs.lastRenderedControlsKey = null; rs.renderedRevision = 0; }
      this.markDirty(key);
      await this.flush(key);
    }
    const ref = this.store.getStatusMessage(target);
    return { text: `Statusbar reset.\nLive messageId: ${ref?.messageId ?? "pending"}` };
  }

  private async handlePinCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    this.store.updateConversation(target, (c) => ({ ...c, enabled: true, pinMode: true }));
    this.store.schedulePersist();
    const key = this.runtimeKey(target);
    this.getOrCreateRenderState(target);
    this.markDirty(key);
    await this.flush(key);
    const ref = this.store.getStatusMessage(target);
    if (ref) {
      try { await this.transport.pinStatusMessage({ target, message: ref }); }
      catch (err) { this.api.logger.warn(`statusbar pin failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return { text: `Statusbar pinned.\nmessageId: ${ref?.messageId ?? "pending"}` };
  }

  private async handleUnpinCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    const ref = this.store.getStatusMessage(target);
    if (ref) {
      try { await this.transport.unpinStatusMessage({ target, message: ref }); }
      catch (err) { this.api.logger.warn(`statusbar unpin failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    this.store.updateConversation(target, (c) => ({ ...c, pinMode: false }));
    this.store.schedulePersist();
    return { text: "Statusbar unpinned." };
  }

  private async handleSettingsCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    const prefs = this.store.getConversation(target);
    return {
      text: [
        "Statusbar settings",
        `enabled=${prefs.enabled} mode=${prefs.mode} pin=${prefs.pinMode}`,
        `throttleMs=${this.config.throttleMs} minThrottleMs=${this.config.minThrottleMs}`,
        `liveTickMs=${this.config.liveTickMs}`,
        `newMessagePerRun=${this.config.newMessagePerRun}`,
        "",
        "Commands: /sbon /sboff /sbmode /sbpin /sbunpin /sbstatus /sbreset /sbbuttons",
      ].join("\n"),
    };
  }

  private async handleButtonsCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) return { text: "Statusbar: unable to resolve this chat." };
    const prefs = this.store.getConversation(target);
    const next = !prefs.buttonsEnabled;
    this.store.updateConversation(target, (c) => ({ ...c, buttonsEnabled: next }));
    this.store.schedulePersist();
    const key = this.runtimeKey(target);
    const rs = this.renderStates.get(key);
    if (rs) { rs.lastRenderedControlsKey = ""; this.markDirty(key, true); }
    return { text: `Inline buttons: ${next ? "ON ✅" : "OFF ❌"}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin export
// ────────────────────────────────────────────────────────────────────────────

export default {
  id: "openclaw-statusbar",
  name: "Statusbar",
  description: "Telegram statusline for OpenClaw agent runs",
  register(api: OpenClawPluginApi) {
    const runtime = new StatusbarRuntime(api);
    void runtime.init()
      .then(() => api.logger.info("openclaw-statusbar plugin initialized"))
      .catch((err) => api.logger.error(`openclaw-statusbar init failed: ${err instanceof Error ? err.message : String(err)}`));
    return { destroy: () => runtime.destroy() };
  },
};