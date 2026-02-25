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
import type {
  RunPhase,
  SessionRuntime,
  StatusMode,
  StatusbarPluginConfig,
  TelegramTarget,
} from "./src/types.js";

// fix #6: regex come costanti di modulo
const RE_COMMAND  = /^\/[a-z0-9_]+(?:\s|$)/i;
const RE_AGENT_ID = /^agent:([^:]+):/;
const RE_AGENT_MAIN = /^agent:([^:]+):main$/;

type SessionTargetRef = { target: TelegramTarget; seenAtMs: number };
type SenderTargetRef  = { target: TelegramTarget; seenAtMs: number };

const SESSION_TARGET_TTL_MS = 30 * 60 * 1000;
// fix #1: rimuove sessioni completate dopo 2h per evitare memory leak
const SESSION_STALE_MS      =  2 * 60 * 60 * 1000;
// fix #7: prune eseguito al massimo ogni 5 minuti, non ad ogni messaggio ricevuto
const PRUNE_INTERVAL_MS     =  5 * 60 * 1000;

// Fasi "attive" che necessitano di tick periodici
const ACTIVE_PHASES = new Set<RunPhase>(["queued", "running", "tool"]);

class StatusbarRuntime {
  private readonly api: OpenClawPluginApi;
  private readonly config: StatusbarPluginConfig;
  private readonly store: StatusbarStore;
  private readonly transport: TelegramTransport;
  private readonly sessions      = new Map<string, SessionRuntime>();
  private readonly sessionTargets = new Map<string, SessionTargetRef>();
  private readonly senderTargets  = new Map<string, SenderTargetRef>();
  private liveTicker: ReturnType<typeof setInterval> | null = null;
  // fix #7: timestamp dell'ultimo prune per evitare scansioni ridondanti
  private lastPruneMs = 0;

  constructor(api: OpenClawPluginApi) {
    this.api    = api;
    this.config = normalizePluginConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    this.store = new StatusbarStore({
      stateDir,
      enabledByDefault:    this.config.enabledByDefault,
      defaultMode:         this.config.defaultMode,
      defaultLayout:       this.config.defaultLayout,
      defaultProgressMode: this.config.defaultProgressMode,
      // fix #10: passa il logger allo store per loggare corruzioni
      log: (msg) => this.api.logger.warn(msg),
    });
    this.transport = new TelegramTransport({ api, config: this.config });
  }

  async init(): Promise<void> {
    await this.store.load();
    this.startLiveTicker();

    this.api.registerCommand({
      name: "sbon",
      description: "Enable statusline for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => this.handleEnableCommand(ctx),
    });
    this.api.registerCommand({
      name: "sboff",
      description: "Disable statusline for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => this.handleDisableCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbmode",
      description: "Set statusline mode: minimal|normal|detailed",
      acceptsArgs: true,
      handler: async (ctx) => this.handleModeCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbstatus",
      description: "Show current statusbar mapping for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => this.handleStatusCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbreset",
      description: "Reset statusbar message reference for this Telegram chat",
      acceptsArgs: false,
      handler: async (ctx) => this.handleResetCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbpin",
      description: "Pin statusline and keep updating the same message",
      acceptsArgs: false,
      handler: async (ctx) => this.handlePinCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbunpin",
      description: "Unpin statusline and create a new message per run",
      acceptsArgs: false,
      handler: async (ctx) => this.handleUnpinCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbsettings",
      description: "Show statusbar settings and useful commands",
      acceptsArgs: false,
      handler: async (ctx) => this.handleSettingsCommand(ctx),
    });
    this.api.registerCommand({
      name: "sbbuttons",
      description: "Toggle inline buttons on/off",
      acceptsArgs: false,
      handler: async (ctx) => this.handleButtonsCommand(ctx),
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

  // fix #2: teardown esplicito — ferma ticker e libera tutti i timer
  destroy(): void {
    if (this.liveTicker) {
      clearInterval(this.liveTicker);
      this.liveTicker = null;
    }
    for (const s of this.sessions.values()) {
      if (s.renderTimer) clearTimeout(s.renderTimer);
      if (s.hideTimer)   clearTimeout(s.hideTimer);
    }
    this.sessions.clear();
  }

  private startLiveTicker(): void {
    if (this.liveTicker) {
      clearInterval(this.liveTicker);
      this.liveTicker = null;
    }
    const tickMs = Math.max(250, this.config.liveTickMs);
    this.liveTicker = setInterval(() => { this.onLiveTick(); }, tickMs);
    this.liveTicker.unref?.();
  }

  // fix #14: early-exit ordinato dal meno al più costoso + fix #1: cleanup periodico
  private onLiveTick(): void {
    const nowMs      = Date.now();
    const cadenceMs  = Math.max(this.config.liveTickMs, this.config.minThrottleMs);

    for (const session of this.sessions.values()) {
      // 1. check economico: fase inattiva → skip immediato
      if (!ACTIVE_PHASES.has(session.phase)) continue;
      // 2. check economico: throttle locale → skip immediato
      if (nowMs - session.lastRenderedAtMs < cadenceMs) continue;
      // 3. check costoso: lookup store — solo se i precedenti passano
      if (!this.store.getConversation(session.target).enabled) continue;

      this.markDirty(session); // tick periodico: urgente=false, rispetta throttle
    }

    // fix #1: pulizia sessioni stantie
    this.cleanupSessions(nowMs);
    // fix #7: prune dei target map con debounce
    this.maybePruneSessionTargets(nowMs);
  }

  // fix #1: rimuove sessioni completate da più di SESSION_STALE_MS
  private cleanupSessions(nowMs: number): void {
    for (const [key, s] of this.sessions.entries()) {
      if (
        !ACTIVE_PHASES.has(s.phase) &&
        s.endedAtMs != null &&
        nowMs - s.endedAtMs > SESSION_STALE_MS
      ) {
        if (s.renderTimer) clearTimeout(s.renderTimer);
        if (s.hideTimer)   clearTimeout(s.hideTimer);
        this.sessions.delete(key);
      }
    }
  }

  // fix #7: prune con debounce — eseguito al massimo ogni PRUNE_INTERVAL_MS
  private maybePruneSessionTargets(nowMs: number): void {
    if (nowMs - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneMs = nowMs;
    this.pruneSessionTargets(nowMs);
  }

  private pruneSessionTargets(nowMs: number): void {
    for (const [key, entry] of this.sessionTargets.entries()) {
      if (nowMs - entry.seenAtMs > SESSION_TARGET_TTL_MS) this.sessionTargets.delete(key);
    }
    for (const [key, entry] of this.senderTargets.entries()) {
      if (nowMs - entry.seenAtMs > SESSION_TARGET_TTL_MS) this.senderTargets.delete(key);
    }
  }

  private trackSessionTarget(sessionKey: string, target: TelegramTarget): void {
    // fix #7: rimosso pruneSessionTargets() qui — ora è debounced in onLiveTick
    this.sessionTargets.set(sessionKey, { target, seenAtMs: Date.now() });
  }

  private trackAgentMainAlias(sessionKey: string, target: TelegramTarget): void {
    // fix #6: usa costante RE_AGENT_ID
    const match   = RE_AGENT_ID.exec(sessionKey);
    const agentId = match?.[1]?.trim() || "main";
    this.trackSessionTarget(`agent:${agentId}:main`, target);
  }

  private trackSenderTarget(senderId: string | null, target: TelegramTarget): void {
    const sender = (senderId ?? "").trim();
    if (!sender) return;
    // fix #7: rimosso pruneSessionTargets() qui
    const key = `${target.accountId}::${sender}`;
    this.senderTargets.set(key, { target, seenAtMs: Date.now() });
  }

  private resolveTargetFromSender(params: {
    senderId?: string;
    accountId?: string;
  }): TelegramTarget | null {
    const sender = (params.senderId ?? "").trim();
    if (!sender) return null;

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
    if (tracked) {
      tracked.seenAtMs = Date.now();
      return tracked.target;
    }

    const fromKey = resolveTelegramTargetFromSessionKey(key);
    if (fromKey) {
      // fix #23: allinea accountId con target già tracciato per lo stesso chatId
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

    // fix #6: usa costante RE_AGENT_MAIN
    const mainMatch = RE_AGENT_MAIN.exec(key);
    if (mainMatch?.[1]) {
      const accountId = mainMatch[1].trim();
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
    if (direct) return direct;
    if ((ctx.channel ?? "").trim().toLowerCase() !== "telegram") return null;
    return this.resolveTargetFromSender({ senderId: ctx.senderId, accountId: ctx.accountId });
  }

  // fix #9: separatore | invece di : — evita ambiguità con conversationId che contiene ":"
  private resolveRuntimeSessionKey(target: TelegramTarget): string {
    return `${target.accountId}|${target.conversationId}|${target.threadId ?? "main"}`;
  }

  private createSessionState(params: { sessionKey: string; target: TelegramTarget }): SessionRuntime {
    return {
      sessionKey: params.sessionKey,
      target: params.target,
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
    };
  }

  private getOrCreateSession(target: TelegramTarget): SessionRuntime {
    const runtimeSessionKey = this.resolveRuntimeSessionKey(target);
    const existing = this.sessions.get(runtimeSessionKey);
    if (existing) {
      existing.target = target;
      return existing;
    }
    const created = this.createSessionState({ sessionKey: runtimeSessionKey, target });
    this.sessions.set(runtimeSessionKey, created);
    return created;
  }

  // fix #21: parametro urgent — i cambi di fase bypassano il throttle per fluidità immediata
  private markDirty(session: SessionRuntime, urgent = false): void {
    session.desiredRevision += 1;
    if (urgent) {
      // Bypass throttle: l'utente deve vedere il cambio di stato immediatamente
      session.nextAllowedAtMs = 0;
      // fix #22: cancella il timer pendente per permettere il reschedule immediato
      // Senza questo, markDirty(urgent) viene ignorato se scheduleFlush trova renderTimer != null
      if (session.renderTimer) {
        clearTimeout(session.renderTimer);
        session.renderTimer = null;
      }
    }
    this.scheduleFlush(session.sessionKey);
  }

  private scheduleFlush(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session || session.renderTimer || session.isFlushing) return;
    const nowMs   = Date.now();
    const delayMs = Math.max(0, session.nextAllowedAtMs - nowMs);
    session.renderTimer = setTimeout(() => {
      session.renderTimer = null;
      void this.flushSession(sessionKey);
    }, delayMs);
  }

  // fix #21: throttle adattivo per fase — QUEUED risparmia rate limit, TOOL è reattivo
  private resolveThrottleMs(phase: RunPhase): number {
    switch (phase) {
      case "tool":    return Math.max(this.config.minThrottleMs, 2000);
      case "running": return this.config.throttleMs;
      case "queued":  return this.config.throttleMs * 2; // fase statica — risparmia budget
      default:        return this.config.throttleMs;
    }
  }

  private scheduleAutoHide(session: SessionRuntime): void {
    if (this.config.autoHideSeconds <= 0) return;
    if (session.hideTimer) {
      clearTimeout(session.hideTimer);
      session.hideTimer = null;
    }
    session.hideTimer = setTimeout(() => {
      session.hideTimer = null;
      const current = this.sessions.get(session.sessionKey);
      if (!current) return;
      current.phase = "idle";
      current.toolName = null;
      current.error = null;
      current.currentRunSteps = 0;
      this.markDirty(current);
    }, this.config.autoHideSeconds * 1000);
  }

  private async flushSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session || session.isFlushing) return;

    const prefs = this.store.getConversation(session.target);
    if (!prefs.enabled) return;

    if (session.desiredRevision <= session.renderedRevision) return;

    // fix #17: controlla il circuit breaker prima di qualsiasi chiamata API
    if (!this.transport.canProceed(session.target.accountId, session.target.chatId)) {
      // Il prossimo liveTick riproverà — non loggare per non spammare
      return;
    }

    session.isFlushing = true;
    try {
      const text        = renderStatusText(session, prefs);
      const controls    = renderStatusButtons(session, prefs);
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
            target:  session.target,
            message: currentRef,
            text,
            buttons: controls,
          });
        } catch (err) {
          if (err instanceof TelegramApiError && err.isEditNotFound()) {
            this.store.setStatusMessage(session.target, null);
            await this.store.persist();
            nextRef = null;
          } else if (err instanceof TelegramApiError && err.isRateLimit()) {
            // fix #17: 429 già gestito dal transport (circuit breaker aggiornato e loggato)
            // Schedula il prossimo tentativo dopo la fine del cooldown
            const remainingMs = this.transport.rateLimiterRemainingMs(
              session.target.accountId,
              session.target.chatId,
            );
            session.nextAllowedAtMs = Date.now() + Math.max(remainingMs, this.config.throttleMs);
            return;
          } else {
            throw err;
          }
        }
      }

      if (!nextRef) {
        nextRef = await this.transport.sendStatusMessage({
          target:  session.target,
          text,
          buttons: controls,
        });
      }

      const didMessageRefChange =
        !currentRef ||
        currentRef.messageId !== nextRef.messageId ||
        currentRef.chatId    !== nextRef.chatId;

      if (didMessageRefChange) {
        this.store.setStatusMessage(session.target, nextRef);
        await this.store.persist();
        if (prefs.pinMode) {
          try {
            await this.transport.pinStatusMessage({ target: session.target, message: nextRef });
          } catch (err) {
            this.api.logger.warn(`statusbar pin failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      session.lastRenderedText        = text;
      session.lastRenderedControlsKey = controlsKey;
      session.lastRenderedAtMs        = Date.now();
      // fix #21: usa throttle adattivo per fase
      session.nextAllowedAtMs =
        session.lastRenderedAtMs +
        Math.max(this.resolveThrottleMs(session.phase), this.config.minThrottleMs);
      session.renderedRevision = session.desiredRevision;
    } catch (err) {
      this.api.logger.warn(`statusbar render failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      session.isFlushing = false;
      if (session.desiredRevision > session.renderedRevision) {
        this.scheduleFlush(session.sessionKey);
      }
    }
  }

  private async onMessageReceived(
    event: { from: string; content?: string; metadata?: Record<string, unknown> },
    ctx:   { channelId: string; accountId?: string; conversationId?: string },
  ): Promise<void> {
    const target = resolveTelegramTargetFromMessageReceived({ event, ctx });
    if (!target) return;

    const sessionKey = resolveSessionKeyFromMessageReceived({ api: this.api, event, target });
    this.trackSessionTarget(sessionKey, target);
    this.trackAgentMainAlias(sessionKey, target);
    const senderIdRaw = event.metadata?.senderId;
    this.trackSenderTarget(typeof senderIdRaw === "string" ? senderIdRaw : null, target);

    // fix #6: usa costante RE_COMMAND
    if (RE_COMMAND.test((event.content ?? "").trim())) return;

    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    const hadActiveRun = ACTIVE_PHASES.has(session.phase);

    if (!hadActiveRun) {
      const shouldCreateNewMessage = this.config.newMessagePerRun && !prefs.pinMode;
      if (shouldCreateNewMessage) {
        this.store.setStatusMessage(target, null);
        await this.store.persist();
        session.lastRenderedText        = null;
        session.lastRenderedControlsKey = null;
        session.renderedRevision        = 0;
      }

      session.phase         = "queued";
      session.startedAtMs   = Date.now();
      session.endedAtMs     = null;
      session.currentRunSteps = 0;
      session.toolName      = null;
      session.error         = null;
      session.provider      = null;
      session.model         = null;
      session.usageInput    = null;
      session.usageOutput   = null;
      session.lastUsageRenderAtMs = 0;
    }

    session.queuedCount = Math.max(0, session.queuedCount) + 1;
    this.markDirty(session);
  }

  private async onBeforeAgentStart(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on before_agent_start (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    session.runNumber     += 1;
    session.queuedCount   = Math.max(0, session.queuedCount - 1);
    session.currentRunSteps = 0;
    session.phase         = "running";
    session.startedAtMs   = Date.now();
    session.endedAtMs     = null;
    session.toolName      = null;
    session.error         = null;
    session.provider      = null;
    session.model         = null;
    session.usageInput    = null;
    session.usageOutput   = null;
    session.lastUsageRenderAtMs = 0;
    // fix #21: cambio fase → flush urgente, bypass throttle
    this.markDirty(session, true);
  }

  private async onBeforeToolCall(
    event: { toolName: string },
    ctx:   { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on before_tool_call (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    session.currentRunSteps += 1;
    session.phase    = "tool";
    session.toolName = event.toolName;
    // fix #21: cambio fase → flush urgente
    this.markDirty(session, true);
  }

  private async onAfterToolCall(ctx: { sessionKey?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on after_tool_call (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    session.phase    = "running";
    session.toolName = null;
    // fix #21: cambio fase → flush urgente
    this.markDirty(session, true);
  }

  private async onLlmOutput(
    event: { provider: string; model: string; usage?: { input?: number; output?: number } },
    ctx:   { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on llm_output (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    const isFirstModel = !session.model && event.model;
    session.provider    = event.provider;
    session.model       = event.model;
    // Accumula token invece di sovrascrivere
    const newInput  = typeof event.usage?.input  === "number" ? Math.trunc(event.usage.input)  : 0;
    const newOutput = typeof event.usage?.output === "number" ? Math.trunc(event.usage.output) : 0;
    session.usageInput  = (session.usageInput  ?? 0) + newInput;
    session.usageOutput = (session.usageOutput ?? 0) + newOutput;

    if (isFirstModel) {
      // Primo LLM output: urgente, l'utente deve vedere il modello subito
      this.markDirty(session, true);
    } else if (prefs.mode === "detailed") {
      const nowMs          = Date.now();
      const usageIntervalMs = Math.max(this.config.minThrottleMs, this.config.liveTickMs);
      if (nowMs - session.lastUsageRenderAtMs >= usageIntervalMs) {
        session.lastUsageRenderAtMs = nowMs;
        this.markDirty(session); // llm_output successivi: non urgente
      }
    }
  }

  private async onAgentEnd(
    event: { success: boolean; error?: string; durationMs?: number },
    ctx:   { sessionKey?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on agent_end (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    const nowMs   = Date.now();

    if (
      typeof event.durationMs === "number" &&
      Number.isFinite(event.durationMs) &&
      event.durationMs > 0
    ) {
      session.startedAtMs = nowMs - Math.trunc(event.durationMs);
    }

    session.endedAtMs = nowMs;
    session.phase     = event.success ? "done" : "error";
    session.toolName  = null;
    session.error     = event.error ?? null;
    // fix #21: completamento/errore → flush urgente, l'utente deve vedere il risultato subito
    this.markDirty(session, true);

    if (event.success) {
      const durationMs     = Math.max(1000, (session.endedAtMs ?? nowMs) - session.startedAtMs);
      const completedSteps = Math.max(1, session.currentRunSteps);
      this.store.updateConversation(target, (current) => {
        const n             = Math.max(0, current.historyRuns);
        const nextRuns      = n + 1;
        const nextAvgDurationMs =
          n === 0
            ? durationMs
            : Math.round((current.avgDurationMs * n + durationMs) / nextRuns);
        const nextAvgSteps =
          n === 0
            ? completedSteps
            : (current.avgSteps * n + completedSteps) / nextRuns;
        return {
          ...current,
          historyRuns:   nextRuns,
          avgDurationMs: nextAvgDurationMs,
          avgSteps:      Number.isFinite(nextAvgSteps) ? nextAvgSteps : completedSteps,
        };
      });
      await this.store.persist();
    }

    if (session.queuedCount <= 0) {
      this.scheduleAutoHide(session);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Command handlers
  // ──────────────────────────────────────────────────────────────────────────

  private async handleEnableCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbon again." };
    }

    const prefs = this.store.updateConversation(target, (c) => ({ ...c, enabled: true }));
    this.store.setStatusMessage(target, null);
    this.trackSessionTarget("agent:main:main", target);
    this.trackSessionTarget(`agent:${target.accountId}:main`, target);
    await this.store.persist();

    const session = this.getOrCreateSession(target);
    session.phase           = "idle";
    session.queuedCount     = 0;
    session.currentRunSteps = 0;
    session.startedAtMs     = Date.now();
    session.endedAtMs       = Date.now();
    session.toolName        = null;
    session.error           = null;
    this.markDirty(session);
    await this.flushSession(session.sessionKey);
    const ref = this.store.getStatusMessage(target);

    return {
      text: `Statusbar enabled. Mode: ${prefs.mode}\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}\nLive messageId: ${ref?.messageId ?? "pending"}`,
    };
  }

  private async handleDisableCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sboff again." };
    }
    this.store.updateConversation(target, (c) => ({ ...c, enabled: false }));
    await this.store.persist();
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
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbmode again." };
    }

    const nextMode = this.parseModeArg(ctx.args);
    if (!nextMode) {
      const current = this.store.getConversation(target);
      return { text: `Current mode: ${current.mode}\nUsage: /sbmode minimal|normal|detailed` };
    }

    const updated = this.store.updateConversation(target, (c) => ({ ...c, mode: nextMode, enabled: true }));
    await this.store.persist();

    for (const session of this.sessions.values()) {
      if (
        session.target.accountId    === target.accountId &&
        session.target.conversationId === target.conversationId &&
        session.target.threadId     === target.threadId
      ) {
        this.markDirty(session);
      }
    }

    return {
      text: `Mode set: ${updated.mode}\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}`,
    };
  }

  // fix #16: stile array uniforme per tutti gli handler multi-riga
  private async handleStatusCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbstatus again." };
    }

    const prefs   = this.store.getConversation(target);
    const ref     = this.store.getStatusMessage(target);
    const runtime = this.getOrCreateSession(target);

    return {
      text: [
        "Statusbar mapping",
        `account=${target.accountId}`,
        `conversation=${target.conversationId}`,
        `chat=${target.chatId}`,
        `thread=${target.threadId ?? "main"}`,
        `enabled=${prefs.enabled}`,
        `mode=${prefs.mode}`,
        `layout=${prefs.layout}`,
        `progressMode=${prefs.progressMode}`,
        `pinMode=${prefs.pinMode}`,
        `historyRuns=${prefs.historyRuns}`,
        `avgDurationMs=${prefs.avgDurationMs}`,
        `avgSteps=${prefs.avgSteps.toFixed(2)}`,
        `runNumber=${runtime.runNumber}`,
        `queued=${runtime.queuedCount}`,
        `messageId=${ref?.messageId ?? "none"}`,
        `messageChat=${ref?.chatId ?? "none"}`,
        `note=${prefs.pinMode ? "pinned mode: same message updated every run" : "unpinned mode: new message every run"}`,
      ].join("\n"),
    };
  }

  private async handleResetCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbreset again." };
    }

    const prefs = this.store.getConversation(target);
    this.store.setStatusMessage(target, null);
    await this.store.persist();

    if (prefs.enabled) {
      const session = this.getOrCreateSession(target);
      session.phase           = "idle";
      session.queuedCount     = 0;
      session.currentRunSteps = 0;
      session.startedAtMs     = Date.now();
      session.endedAtMs       = Date.now();
      session.toolName        = null;
      session.error           = null;
      this.markDirty(session);
      await this.flushSession(session.sessionKey);
    }

    const ref = this.store.getStatusMessage(target);
    return {
      text: `Statusbar message reference reset.\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}\nLive messageId: ${ref?.messageId ?? "pending"}`,
    };
  }

  private async handlePinCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbpin again." };
    }

    this.store.updateConversation(target, (c) => ({ ...c, enabled: true, pinMode: true }));
    await this.store.persist();

    const session = this.getOrCreateSession(target);
    this.markDirty(session);
    await this.flushSession(session.sessionKey);

    const ref = this.store.getStatusMessage(target);
    if (ref) {
      try {
        await this.transport.pinStatusMessage({ target, message: ref });
      } catch (err) {
        this.api.logger.warn(`statusbar pin failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      text: `Statusbar pinned.\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}\nLive messageId: ${ref?.messageId ?? "pending"}`,
    };
  }

  private async handleUnpinCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbunpin again." };
    }

    const ref = this.store.getStatusMessage(target);
    if (ref) {
      try {
        await this.transport.unpinStatusMessage({ target, message: ref });
      } catch (err) {
        this.api.logger.warn(`statusbar unpin failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.store.updateConversation(target, (c) => ({ ...c, pinMode: false }));
    await this.store.persist();

    return {
      text: `Statusbar unpinned.\nTarget: account=${target.accountId} chat=${target.chatId} thread=${target.threadId ?? "main"}`,
    };
  }

  private async handleSettingsCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbsettings again." };
    }

    const prefs = this.store.getConversation(target);
    return {
      text: [
        "Statusbar settings",
        `enabled=${prefs.enabled}`,
        `mode=${prefs.mode}`,
        `layout=${prefs.layout}`,
        `progressMode=${prefs.progressMode}`,
        `pinMode=${prefs.pinMode}`,
        `liveTickMs=${this.config.liveTickMs}`,
        `throttleMs=${this.config.throttleMs}`,
        `maxRetriesEdit=${this.config.maxRetriesEdit}`,
        `maxRetriesSend=${this.config.maxRetriesSend}`,
        `newMessagePerRun=${this.config.newMessagePerRun}`,
        `inlineControls=${this.config.showInlineControls}`,
        "",
        "Commands:",
        "/sbon  /sboff",
        "/sbmode minimal|normal|detailed",
        "/sbpin  /sbunpin",
        "/sbstatus  /sbreset",
        "/sbbuttons",
      ].join("\n"),
    };
  }

  private async handleButtonsCommand(ctx: {
    channel: string; senderId?: string; accountId?: string;
    to?: string; from?: string; messageThreadId?: number;
  }): Promise<ReplyPayload> {
    const target = this.resolveTargetForCommand(ctx);
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbbuttons again." };
    }

    const prefs = this.store.getConversation(target);
    const next = !prefs.buttonsEnabled;
    this.store.updateConversation(target, (current) => ({ ...current, buttonsEnabled: next }));
    await this.store.persist();

    // Flush per aggiornare subito (rimuovere/aggiungere bottoni)
    for (const session of this.sessions.values()) {
      if (session.target.chatId === target.chatId && session.target.threadId === target.threadId) {
        session.lastRenderedControlsKey = "";
        this.markDirty(session, true);
      }
    }

    return { text: `Inline buttons: ${next ? "ON ✅" : "OFF ❌"}` };
  }
}

export default {
  id: "openclaw-statusbar",
  name: "Statusbar",
  description: "Telegram statusline for OpenClaw agent runs",
  register(api: OpenClawPluginApi) {
    const runtime = new StatusbarRuntime(api);
    // fix #2: restituisce destroy() per teardown corretto su hot-reload
    void runtime
      .init()
      .then(() => { api.logger.info("openclaw-statusbar plugin initialized"); })
      .catch((err) => {
        api.logger.error(`openclaw-statusbar init failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return { destroy: () => runtime.destroy() };
  },
};
