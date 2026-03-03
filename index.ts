import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
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
const ACTIVE_PHASES = new Set<RunPhase>(["queued", "running", "thinking", "tool"]); // "sending" excluded: 2s timer handles it, no live tick needed

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
    // Cleanup stale messages from previous gateway run — safe fire-and-forget
    this.cleanupStaleMessages().catch(() => { /* intentionally ignored */ });
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
    this.api.on("after_tool_call", async (event, ctx) => {
      await this.onAfterToolCall(event, ctx);
    });
    this.api.on("llm_output", async (event, ctx) => {
      await this.onLlmOutput(event, ctx);
    });
    this.api.on("agent_end", async (event, ctx) => {
      await this.onAgentEnd(event, ctx);
    });
    this.api.on("llm_input", async (event, ctx) => {
      await this.onLlmInput(event, ctx);
    });
    // Note: message_sending/message_sent hooks NOT used — they fire for statusbar edits too,
    // causing premature done transitions. 2s pendingDeliveryTimer is the sole mechanism.
  }

  // fix #2: teardown esplicito — ferma ticker e libera tutti i timer
  destroy(): void {
    if (this.liveTicker) {
      clearInterval(this.liveTicker);
      this.liveTicker = null;
    }
    for (const s of this.sessions.values()) {
      if (s.renderTimer)           clearTimeout(s.renderTimer);
      if (s.hideTimer)             clearTimeout(s.hideTimer);
      if (s.maxRunTimer)           clearTimeout(s.maxRunTimer);
      if (s.pendingDeliveryTimer)  clearTimeout(s.pendingDeliveryTimer);
    }
    this.sessions.clear();
    this.store.flushPersist();
  }

  private async cleanupStaleMessages(): Promise<void> {
    const flagPath = "/tmp/statusbar-cleanup-running";
    try {
      const fd = openSync(flagPath, "wx");
      closeSync(fd);
    } catch {
      return; // another instance is already running cleanup
    }
    try {
    await new Promise<void>(r => setTimeout(r, 4000)); // wait for gateway to settle
    const targets = this.store.getAllTargets();
    for (const target of targets) {
      try {
        const ref = this.store.getStatusMessage(target);
        if (!ref) continue;
        const prefs = this.store.getConversation(target);
        if (!prefs.enabled) continue;
        // Skip targets that already have an active session (don't overwrite live runs)
        const runtimeKey = this.resolveRuntimeSessionKey(target);
        const existingSession = this.sessions.get(runtimeKey);
        if (existingSession && ACTIVE_PHASES.has(existingSession.phase)) continue;
        const idleSession = this.createSessionState({ sessionKey: "init-cleanup", target });
        idleSession.phase = "idle";
        const text = renderStatusText(idleSession, prefs);
        await this.transport.editStatusMessage({ target, message: ref, text, buttons: undefined });
      } catch (err) {
        // If message no longer exists, clear the stale ref to stop future errors
        const msg = err instanceof Error ? err.message : String(err);
        if (/message to edit not found/i.test(msg)) {
          this.store.setStatusMessage(target, null);
          this.store.schedulePersist();
        }
        // all other errors (network, etc.) — silently ignore
      }
    }
    } finally {
      try { unlinkSync(flagPath); } catch { /* ignore */ }
    }
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
    // fix #28: usa chatId+threadId come key, NON accountId
    // accountId può essere "main" o "default" per lo stesso chat (hook da contesti diversi)
    // → creava due sessioni parallele che editavano lo stesso messaggio → flickering
    return `chat|${target.chatId}|${target.threadId ?? "main"}`;
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
      maxRunTimer: null,
      pendingDelivery: false,
      pendingDeliveryTimer: null,
      currentRunId: null,
      isThinkingRun: false,
      predictedSteps: 0,
      toolDurationsRaw: new Map(),
      thinkingLevel: null,
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

  private transitionPhase(session: SessionRuntime, newPhase: RunPhase, opts?: { urgent?: boolean; toolName?: string }): void {
    if (session.phase === newPhase && newPhase !== "tool") return; // skip no-op
    session.phase = newPhase;
    if (opts?.toolName !== undefined) session.toolName = opts.toolName;
    if (newPhase === "done" || newPhase === "error") {
      session.endedAtMs = Date.now();
      this.releaseLock(session.target.chatId);
    }
    this.markDirty(session, opts?.urgent ?? true);
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
      current.toolName = null;
      current.error = null;
      current.currentRunSteps = 0;
      this.transitionPhase(current, "idle", { urgent: false });
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
            this.store.schedulePersist();
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
        // Solo se il plugin è ancora abilitato per questo target
        if (prefs.enabled) {
          nextRef = await this.transport.sendStatusMessage({
            target:  session.target,
            text,
            buttons: controls,
          });
        } else {
          // Plugin disabilitato — non creare nuovi messaggi
          session.renderedRevision = session.desiredRevision;
          return;
        }
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
        this.store.schedulePersist();
        session.lastRenderedText        = null;
        session.lastRenderedControlsKey = null;
        session.renderedRevision        = 0;
      }

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
      this.transitionPhase(session, "queued", { urgent: false });
    }

    session.queuedCount = Math.max(0, session.queuedCount) + 1;
    this.markDirty(session);
  }


  // fix #29: cross-instance lock — due istanze del plugin ([gateway] e [plugins])
  // hanno Maps in-memory separati, causando sessioni parallele sullo stesso chat.
  // Usiamo un lock file su /tmp/ come segnale condiviso.
  private lockPath(chatId: string | number): string {
    return `/tmp/statusbar-lock-${chatId}`;
  }
  private acquireLock(chatId: string | number): boolean {
    const lockFile = this.lockPath(chatId);
    const now = Date.now();
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, now.toString(), "utf8");
      closeSync(fd);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // Lock exists — check if stale (>90s)
      try {
        const content = readFileSync(lockFile, "utf8");
        const ts = parseInt(content, 10);
        if (isNaN(ts) || now - ts >= 90_000) {
          // Stale lock — overwrite directly (atomic for single-host)
          writeFileSync(lockFile, now.toString(), "utf8");
          return true;
        }
      } catch { return false; }
      return false;
    }
  }
  private releaseLock(chatId: string | number): void {
    try { unlinkSync(this.lockPath(chatId)); } catch { /* ignore */ }
  }
  private touchLock(chatId: string | number): void {
    try { writeFileSync(this.lockPath(chatId), Date.now().toString(), "utf8"); } catch { /* ignore */ }
  }

  private async onBeforeAgentStart(ctx: { sessionKey?: string; thinkingLevel?: string; reasoning?: string }): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) {
      this.api.logger.warn(`statusbar: no target for session on before_agent_start (${sessionKey})`);
      return;
    }
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    // fix #29: cross-instance lock — se un'altra istanza sta già gestendo questo chat, skip
    const session = this.getOrCreateSession(target);
    if (session.phase === "running" || session.phase === "thinking" || session.phase === "tool") {
      this.touchLock(target.chatId);
      return;
    }
    if (!this.acquireLock(target.chatId)) {
      return;
    }
    
    // fix #24: adaptive thinking fires two before_agent_start/agent_end cycles per user message.
    // Cancel any pending "done" render or hide timer so the user doesn't see a flash of "Done"
    // between the thinking turn and the response turn.
    if (session.hideTimer) {
      clearTimeout(session.hideTimer);
      session.hideTimer = null;
    }
    if (session.renderTimer && (session.phase === "done" || session.phase === "idle" || session.phase === "error")) {
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
    }
    // v2.0: cancel pending delivery if we're starting a new turn
    if (session.pendingDeliveryTimer) {
      clearTimeout(session.pendingDeliveryTimer);
      session.pendingDeliveryTimer = null;
    }
    session.pendingDelivery = false;
    session.isThinkingRun = false;
    session.currentRunId = null;
    // v2.1: seed predictedSteps from run history for immediate N/M▸ display
    session.predictedSteps = prefs.historyRuns > 0 ? Math.round(Math.max(1, prefs.avgSteps)) : 0;
    session.runNumber     += 1;
    session.queuedCount   = Math.max(0, session.queuedCount - 1);
    session.currentRunSteps = 0;
    session.startedAtMs   = Date.now();
    session.endedAtMs     = null;
    session.toolName      = null;
    session.error         = null;
    session.provider      = null;
    session.model         = null;
    session.usageInput    = null;
    session.usageOutput   = null;
    session.lastUsageRenderAtMs = 0;
    // Extract thinking level from context
    const thinkingRaw = ctx.thinkingLevel ?? ctx.reasoning;
    if (typeof thinkingRaw === "string" && thinkingRaw.trim()) {
      session.thinkingLevel = thinkingRaw.trim();
    }
    // fix #25: safety net — se agent_end non scatta entro 300s, forza "done"
    if (session.maxRunTimer) {
      clearTimeout(session.maxRunTimer);
      session.maxRunTimer = null;
    }
    session.maxRunTimer = setTimeout(() => {
      session.maxRunTimer = null;
      if (session.phase === "running") {
        this.transitionPhase(session, "done");
      }
    }, 300_000);
    this.transitionPhase(session, "running");
  }

  private async onBeforeToolCall(
    event: { toolName: string; params?: Record<string, unknown> },
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
    // v2.1: grow predicted to at least current step count (reactive counter)
    session.predictedSteps = Math.max(session.predictedSteps, session.currentRunSteps);
    this.transitionPhase(session, "tool", { toolName: event.toolName });
  }

  private async onAfterToolCall(
    event: { toolName: string; durationMs?: number },
    ctx: { sessionKey?: string },
  ): Promise<void> {
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
    session.toolName = null;
    this.transitionPhase(session, "running");
    // v2.0: track per-tool duration for ETA
    if (typeof event.durationMs === "number" && event.durationMs > 0) {
      const toolKey = event.toolName ?? "unknown";
      const samples = session.toolDurationsRaw.get(toolKey) ?? [];
      samples.push(event.durationMs);
      if (samples.length > 20) samples.shift();
      session.toolDurationsRaw.set(toolKey, samples);
      // Cap at 50 keys — remove least-sampled entries
      if (session.toolDurationsRaw.size > 50) {
        let minKey = "";
        let minCount = Infinity;
        for (const [k, v] of session.toolDurationsRaw) {
          if (v.length < minCount) { minCount = v.length; minKey = k; }
        }
        if (minKey) session.toolDurationsRaw.delete(minKey);
      }
    }
  }

  private async onLlmInput(
    event: { runId: string; sessionId: string; provider: string; model: string; historyMessages: unknown[]; imagesCount: number },
    ctx:   { sessionKey?: string; thinkingLevel?: string; reasoning?: string },
  ): Promise<void> {
    const sessionKey = (ctx.sessionKey ?? "").trim();
    if (!sessionKey) return;
    const target = this.resolveTargetForSession(sessionKey);
    if (!target) return;
    const prefs = this.store.getConversation(target);
    if (!prefs.enabled) return;

    const session = this.getOrCreateSession(target);
    session.currentRunId = event.runId;
    session.isThinkingRun = true; // assume thinking until llm_output proves otherwise
    const thinkingRaw = ctx.thinkingLevel ?? ctx.reasoning;
    if (typeof thinkingRaw === "string" && thinkingRaw.trim()) {
      session.thinkingLevel = thinkingRaw.trim();
    }
    if (session.phase === "running") {
      this.transitionPhase(session, "thinking");
    }
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

    // v2.0: detect thinking vs response run via assistantTexts
    const assistantTexts = (event as { assistantTexts?: unknown[] }).assistantTexts;
    if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
      const allText = assistantTexts.map(t => typeof t === 'string' ? t : JSON.stringify(t)).join('');
      const hasToolUse = allText.includes('"type":"tool_use"') || allText.includes('"type": "tool_use"');
      const hasVisibleText = assistantTexts.some((t) => {
        if (typeof t !== "string") return false;
        const trimmed = t.trim();
        return trimmed.length > 10 && !trimmed.startsWith('{') && !trimmed.startsWith('<');
      });

      if (hasToolUse || hasVisibleText) {
        session.isThinkingRun = false;
        if (session.phase === "thinking") {
          this.transitionPhase(session, "running");
        }
      }

      // v2.0: extract predicted tool count from tool_use blocks
      if (hasToolUse) {
        const matches = allText.match(/"type"\s*:\s*"tool_use"/g);
        const count = matches?.length ?? 0;
        if (count > 0) {
          session.predictedSteps = Math.max(session.predictedSteps, session.currentRunSteps + count);
        }
      }
    }

    if (isFirstModel) {
      this.markDirty(session, true);
    } else if (prefs.mode === "detailed") {
      const nowMs          = Date.now();
      const usageIntervalMs = Math.max(this.config.minThrottleMs, this.config.liveTickMs);
      if (nowMs - session.lastUsageRenderAtMs >= usageIntervalMs) {
        session.lastUsageRenderAtMs = nowMs;
        this.markDirty(session);
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
    session.toolName  = null;
    session.error     = event.error ?? null;

    session.pendingDelivery = event.success;

    // Cancel any pending delay timer
    if (session.renderTimer) { clearTimeout(session.renderTimer); session.renderTimer = null; }

    // v2.0: "sending" phase — shown briefly then auto-transitions to "done"
    this.transitionPhase(session, event.success ? "sending" : "error");

    if (event.success) {
      // Primary: auto-transition to done after 2s (message_sending/sent unreliable for bot replies)
      // message_sending/sent hooks act as bonus early triggers if they happen to fire
      if (session.pendingDeliveryTimer) { clearTimeout(session.pendingDeliveryTimer); }
      session.pendingDeliveryTimer = setTimeout(() => {
        session.pendingDeliveryTimer = null;
        if (session.pendingDelivery && session.phase === "sending") {
          session.pendingDelivery = false;
          this.transitionPhase(session, "done");
        }
      }, 2_000);

      const durationMs     = Math.max(1000, (session.endedAtMs ?? nowMs) - session.startedAtMs);
      const completedSteps = Math.max(1, session.currentRunSteps);

      // v2.0: merge per-tool durations into store (exponential moving average)
      const toolSamples = session.toolDurationsRaw;
      this.store.updateConversation(target, (current) => {
        const n             = Math.max(0, current.historyRuns);
        const nextRuns      = n + 1;
        const nextAvgDurationMs =
          n === 0 ? durationMs : Math.round((current.avgDurationMs * n + durationMs) / nextRuns);
        const nextAvgSteps =
          n === 0 ? completedSteps : (current.avgSteps * n + completedSteps) / nextRuns;

        // Merge tool durations: EMA with alpha=0.3
        const nextToolAvg = { ...current.toolAvgDurations };
        let totalDuration = 0;
        let totalCount = 0;
        for (const [toolName, samples] of toolSamples.entries()) {
          if (samples.length === 0) continue;
          const sampleAvg = samples.reduce((a, b) => a + b, 0) / samples.length;
          totalDuration += sampleAvg;
          totalCount += 1;
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
          historyRuns:   nextRuns,
          avgDurationMs: nextAvgDurationMs,
          avgSteps:      Number.isFinite(nextAvgSteps) ? nextAvgSteps : completedSteps,
          toolAvgDurations: nextToolAvg,
        };
      });
      this.store.schedulePersist();
    }

    if (session.queuedCount <= 0) {
      this.scheduleAutoHide(session);
    }
  }

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
    this.store.schedulePersist();

    const session = this.getOrCreateSession(target);
    session.queuedCount     = 0;
    session.currentRunSteps = 0;
    session.startedAtMs     = Date.now();
    session.endedAtMs       = Date.now();
    session.toolName        = null;
    session.error           = null;
    this.transitionPhase(session, "idle", { urgent: false });
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
    if (!target) {
      return { text: "Statusbar: unable to resolve this chat. Send one normal message in this chat, then run /sbmode again." };
    }

    const nextMode = this.parseModeArg(ctx.args);
    if (!nextMode) {
      const current = this.store.getConversation(target);
      return { text: `Current mode: ${current.mode}\nUsage: /sbmode minimal|normal|detailed` };
    }

    const updated = this.store.updateConversation(target, (c) => ({ ...c, mode: nextMode, enabled: true }));
    this.store.schedulePersist();

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
    this.store.schedulePersist();

    if (prefs.enabled) {
      const session = this.getOrCreateSession(target);
      session.queuedCount     = 0;
      session.currentRunSteps = 0;
      session.startedAtMs     = Date.now();
      session.endedAtMs       = Date.now();
      session.toolName        = null;
      session.error           = null;
      this.transitionPhase(session, "idle", { urgent: false });
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
    this.store.schedulePersist();

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
    this.store.schedulePersist();

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
    this.store.schedulePersist();

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
