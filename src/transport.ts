import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  StatusMessageRef,
  StatusbarPluginConfig,
  TelegramInlineButtons,
  TelegramTarget,
} from "./types.js";

const MESSAGE_NOT_MODIFIED_RE       = /message is not modified/i;
const MESSAGE_TO_EDIT_NOT_FOUND_RE  = /message to edit not found/i;
const MESSAGE_TO_UNPIN_NOT_FOUND_RE = /message to unpin not found|chat not modified/i;
// fix #19: pattern per rilevare rate limit da messaggi di errore testuali (path SDK)
const RATE_LIMIT_RE = /429|too many requests|rate.?limit/i;

const FETCH_TIMEOUT_EDIT_MS = 10_000; // edit: timeout aggressivo — è efimero
const FETCH_TIMEOUT_SEND_MS = 15_000; // send/pin: più tollerante — è critico

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };

type TelegramMessage = {
  message_id?: number;
  chat?: { id?: number | string };
};

type TelegramActionResult = {
  details?: Record<string, unknown>;
};

type TelegramTransportOptions = {
  api: OpenClawPluginApi;
  config: StatusbarPluginConfig;
};

export class TelegramApiError extends Error {
  readonly code: number | null;
  readonly description: string;
  readonly retryAfterSeconds: number | null;

  constructor(params: { code?: number; description?: string; retryAfterSeconds?: number }) {
    super(params.description ?? "telegram api error");
    this.code = typeof params.code === "number" ? params.code : null;
    this.description = params.description ?? "telegram api error";
    this.retryAfterSeconds =
      typeof params.retryAfterSeconds === "number" && Number.isFinite(params.retryAfterSeconds)
        ? params.retryAfterSeconds
        : null;
  }

  isRateLimit(): boolean {
    return this.code === 429;
  }

  isEditNotFound(): boolean {
    return this.code === 400 && MESSAGE_TO_EDIT_NOT_FOUND_RE.test(this.description);
  }

  isMessageNotModified(): boolean {
    return this.code === 400 && MESSAGE_NOT_MODIFIED_RE.test(this.description);
  }
}

// fix #17: circuit breaker globale per bot+chat
// Quando un 429 arriva, blocca TUTTE le richieste verso quel (accountId, chatId)
// per la durata del retry_after — non solo la singola chiamata in corso.
class GlobalRateLimiter {
  private readonly pausedUntil = new Map<string, number>();

  onRateLimit(accountId: string, chatId: string, retryAfterSec: number): void {
    const key   = `${accountId}:${chatId}`;
    const until = Date.now() + Math.max(retryAfterSec, 1) * 1000;
    const existing = this.pausedUntil.get(key) ?? 0;
    if (until > existing) {
      this.pausedUntil.set(key, until);
    }
  }

  canProceed(accountId: string, chatId: string): boolean {
    const key   = `${accountId}:${chatId}`;
    const until = this.pausedUntil.get(key) ?? 0;
    if (Date.now() >= until) {
      if (until > 0) this.pausedUntil.delete(key);
      return true;
    }
    return false;
  }

  remainingMs(accountId: string, chatId: string): number {
    const key   = `${accountId}:${chatId}`;
    const until = this.pausedUntil.get(key) ?? 0;
    return Math.max(0, until - Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveJitterMs(): number {
  return Math.floor(Math.random() * 401) - 200;
}

function extractRetryAfterSeconds(
  error: TelegramApiError,
  fallbackMs: number,
  attempt: number,
): number {
  if (error.retryAfterSeconds != null && error.retryAfterSeconds >= 0) {
    return error.retryAfterSeconds;
  }
  return Math.ceil((fallbackMs * Math.max(1, 2 ** attempt)) / 1000);
}

function extractMessageMeta(
  result: TelegramMessage | true,
  fallback: StatusMessageRef,
): StatusMessageRef {
  if (result === true) return fallback;
  const messageId =
    typeof result.message_id === "number" ? result.message_id : fallback.messageId;
  const chatId =
    result.chat?.id != null && String(result.chat.id).trim()
      ? String(result.chat.id)
      : fallback.chatId;
  return { chatId, messageId, updatedAt: Date.now() };
}

function extractMessageMetaFromDetails(
  details: Record<string, unknown> | undefined,
  fallback: StatusMessageRef,
): StatusMessageRef {
  const messageIdRaw = details?.messageId;
  const chatIdRaw    = details?.chatId;
  const messageId =
    typeof messageIdRaw === "number"
      ? Math.trunc(messageIdRaw)
      : typeof messageIdRaw === "string"
        ? Number.parseInt(messageIdRaw, 10)
        : Number.NaN;
  const chatId =
    typeof chatIdRaw === "string"
      ? chatIdRaw
      : typeof chatIdRaw === "number"
        ? String(chatIdRaw)
        : fallback.chatId;
  return {
    chatId,
    messageId: Number.isFinite(messageId) ? messageId : fallback.messageId,
    updatedAt: Date.now(),
  };
}

export class TelegramTransport {
  private readonly api: OpenClawPluginApi;
  private readonly config: StatusbarPluginConfig;
  // fix #17: istanza del circuit breaker condivisa tra tutte le operazioni di questo transport
  private readonly rateLimiter = new GlobalRateLimiter();

  constructor(options: TelegramTransportOptions) {
    this.api    = options.api;
    this.config = options.config;
  }

  // fix #17: esposto per flushSession in index.ts
  canProceed(accountId: string, chatId: string): boolean {
    return this.rateLimiter.canProceed(accountId, chatId);
  }

  rateLimiterRemainingMs(accountId: string, chatId: string): number {
    return this.rateLimiter.remainingMs(accountId, chatId);
  }

  private resolveToken(accountId: string): string {
    const resolution = this.api.runtime.channel.telegram.resolveTelegramToken(this.api.config, {
      accountId,
    });
    const token = resolution.token?.trim() ?? "";
    if (!token) {
      throw new Error(`Statusbar: missing Telegram token for account "${accountId}"`);
    }
    return token;
  }

  // fix #4: AbortController con timeout — previene hang indefiniti su reti lente
  // fix #19: maxRetries esplicito per chiamata — edit=0, send/pin=N
  private async callTelegram<T>(params: {
    token: string;
    method: string;
    payload: Record<string, unknown>;
    maxRetries: number;
    timeoutMs: number;
  }): Promise<T> {
    const baseDelayMs = Math.max(this.config.minThrottleMs, 500);
    let attempt = 0;

    while (true) {
      // fix #4: timeout per ogni singolo tentativo
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), params.timeoutMs);

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${params.token}/${params.method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params.payload),
            signal: controller.signal,
          },
        );

        const parsed = (await response.json()) as TelegramApiResponse<T>;
        if (parsed.ok) return parsed.result;

        throw new TelegramApiError({
          code: parsed.error_code,
          description: parsed.description,
          retryAfterSeconds: parsed.parameters?.retry_after,
        });
      } catch (err) {
        const apiError =
          err instanceof TelegramApiError
            ? err
            : new TelegramApiError({
                description: err instanceof Error ? err.message : String(err),
              });

        if (apiError.isMessageNotModified()) throw apiError;

        if (attempt >= params.maxRetries) throw apiError;

        // fix #19: se maxRetries=0 (edit), il 429 viene propagato immediatamente senza retry
        if (apiError.isRateLimit()) {
          const retryAfterSec = extractRetryAfterSeconds(apiError, baseDelayMs, attempt);
          const sleepMs = Math.max(250, retryAfterSec * 1000 + resolveJitterMs());
          await sleep(sleepMs);
          attempt += 1;
          continue;
        }

        // Retry su 5xx e errori di rete transitori
        if (apiError.code == null || apiError.code >= 500) {
          const sleepMs = Math.max(
            250,
            baseDelayMs * Math.max(1, 2 ** attempt) + resolveJitterMs(),
          );
          await sleep(sleepMs);
          attempt += 1;
          continue;
        }

        throw apiError;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async sendStatusMessage(params: {
    target: TelegramTarget;
    text: string;
    buttons?: TelegramInlineButtons;
  }): Promise<StatusMessageRef> {
    try {
      const result = await this.api.runtime.channel.telegram.sendMessageTelegram(
        params.target.chatId,
        params.text,
        {
          accountId: params.target.accountId,
          messageThreadId: params.target.threadId ?? undefined,
          buttons: params.buttons,
          verbose: false,
        },
      );
      const parsed = Number.parseInt(String(result.messageId), 10);
      if (Number.isFinite(parsed)) {
        return { messageId: parsed, chatId: result.chatId, updatedAt: Date.now() };
      }
    } catch (err) {
      this.api.logger.warn(`statusbar send fallback to direct API: ${String(err)}`);
    }

    const token = this.resolveToken(params.target.accountId);
    const payload: Record<string, unknown> = {
      chat_id: params.target.chatId,
      text: params.text,
    };
    if (params.target.threadId != null) {
      payload.message_thread_id = params.target.threadId;
    }
    if (params.buttons !== undefined) {
      payload.reply_markup = { inline_keyboard: params.buttons };
    }

    // fix #20: send usa maxRetriesSend (critico, ritenta)
    const result = await this.callTelegram<TelegramMessage>({
      token,
      method: "sendMessage",
      payload,
      maxRetries: this.config.maxRetriesSend,
      timeoutMs: FETCH_TIMEOUT_SEND_MS,
    });
    const messageId = typeof result.message_id === "number" ? result.message_id : null;
    const chatId    = result.chat?.id != null ? String(result.chat.id) : params.target.chatId;
    if (messageId == null) {
      throw new Error("Statusbar: sendMessage did not return message_id");
    }
    return { messageId, chatId, updatedAt: Date.now() };
  }

  async editStatusMessage(params: {
    target: TelegramTarget;
    message: StatusMessageRef;
    text: string;
    buttons?: TelegramInlineButtons;
  }): Promise<StatusMessageRef> {
    this.api.logger.debug(`[SB-EDIT] chat=${params.target.chatId} t=${Date.now()}`);
    // Prova prima il path SDK (OpenClaw messageActions)
    try {
      const messageActions = this.api.runtime.channel.telegram.messageActions;
      if (messageActions?.handleAction) {
        const actionResult = (await messageActions.handleAction({
          channel: "telegram",
          action: "edit",
          cfg: this.api.config,
          accountId: params.target.accountId,
          params: {
            chatId: params.message.chatId,
            messageId: params.message.messageId,
            message: params.text,
            buttons: params.buttons,
          },
        })) as TelegramActionResult;
        return extractMessageMetaFromDetails(actionResult.details, params.message);
      }
    } catch (err) {
      // fix #5: preserva il codice originale dell'errore invece di forzare sempre 400
      if (err instanceof TelegramApiError) {
        if (err.isMessageNotModified()) {
          return { ...params.message, updatedAt: Date.now() };
        }
        // fix #17: se è un 429 dal path SDK, aggiorna il circuit breaker e logga
        if (err.isRateLimit()) {
          const retryAfterSec = err.retryAfterSeconds ?? 60;
          this.rateLimiter.onRateLimit(
            params.target.accountId,
            params.target.chatId,
            retryAfterSec,
          );
          this.api.logger.warn(
            `statusbar: 429 rate limit (SDK path) — paused ${retryAfterSec}s` +
            ` (account=${params.target.accountId} chat=${params.target.chatId})`,
          );
        }
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      if (MESSAGE_NOT_MODIFIED_RE.test(message)) {
        return { ...params.message, updatedAt: Date.now() };
      }

      // fix #5: tenta di preservare il codice; rileva rate limit da testo come fallback
      const rawCode = (err as Record<string, unknown>)?.code;
      const isRateLimit = RATE_LIMIT_RE.test(message);
      throw new TelegramApiError({
        code: typeof rawCode === "number" ? rawCode : isRateLimit ? 429 : undefined,
        description: message,
      });
    }

    // Fallback: chiamata diretta all'API Telegram
    const token = this.resolveToken(params.target.accountId);
    const payload: Record<string, unknown> = {
      chat_id:    params.message.chatId,
      message_id: params.message.messageId,
      text:       params.text,
    };
    if (params.buttons !== undefined) {
      payload.reply_markup = { inline_keyboard: params.buttons };
    }

    try {
      // fix #20: edit usa maxRetriesEdit (0) — efimero, nessun retry
      const result = await this.callTelegram<TelegramMessage | true>({
        token,
        method: "editMessageText",
        payload,
        maxRetries: this.config.maxRetriesEdit,
        timeoutMs: FETCH_TIMEOUT_EDIT_MS,
      });
      return extractMessageMeta(result, params.message);
    } catch (err) {
      if (err instanceof TelegramApiError) {
        if (err.isMessageNotModified()) {
          return { ...params.message, updatedAt: Date.now() };
        }
        // fix #17: aggiorna il circuit breaker su 429 dal path diretto
        if (err.isRateLimit()) {
          const retryAfterSec = err.retryAfterSeconds ?? 60;
          this.rateLimiter.onRateLimit(
            params.target.accountId,
            params.target.chatId,
            retryAfterSec,
          );
          this.api.logger.warn(
            `statusbar: 429 rate limit (direct API) — paused ${retryAfterSec}s` +
            ` (account=${params.target.accountId} chat=${params.target.chatId})`,
          );
        }
      }
      throw err;
    }
  }

  async pinStatusMessage(params: {
    target: TelegramTarget;
    message: StatusMessageRef;
  }): Promise<void> {
    const token = this.resolveToken(params.target.accountId);
    // fix #20: pin usa maxRetriesSend — operazione critica
    await this.callTelegram<true>({
      token,
      method: "pinChatMessage",
      payload: {
        chat_id:              params.message.chatId,
        message_id:           params.message.messageId,
        disable_notification: true,
      },
      maxRetries: this.config.maxRetriesSend,
      timeoutMs: FETCH_TIMEOUT_SEND_MS,
    });
  }

  async unpinStatusMessage(params: {
    target: TelegramTarget;
    message: StatusMessageRef;
  }): Promise<void> {
    const token = this.resolveToken(params.target.accountId);
    try {
      // fix #20: unpin usa maxRetriesSend
      await this.callTelegram<true>({
        token,
        method: "unpinChatMessage",
        payload: {
          chat_id:    params.message.chatId,
          message_id: params.message.messageId,
        },
        maxRetries: this.config.maxRetriesSend,
        timeoutMs: FETCH_TIMEOUT_SEND_MS,
      });
    } catch (err) {
      if (
        err instanceof TelegramApiError &&
        err.code === 400 &&
        MESSAGE_TO_UNPIN_NOT_FOUND_RE.test(err.description)
      ) {
        return;
      }
      throw err;
    }
  }
}
