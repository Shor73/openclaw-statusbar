import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  StatusMessageRef,
  StatusbarPluginConfig,
  TelegramInlineButtons,
  TelegramTarget,
} from "./types.js";

const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;
const MESSAGE_TO_EDIT_NOT_FOUND_RE = /message to edit not found/i;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveJitterMs(): number {
  return Math.floor(Math.random() * 401) - 200;
}

function extractRetryAfterSeconds(error: TelegramApiError, fallbackMs: number, attempt: number): number {
  if (error.retryAfterSeconds != null && error.retryAfterSeconds >= 0) {
    return error.retryAfterSeconds;
  }
  const exponentialMs = fallbackMs * Math.max(1, 2 ** attempt);
  return Math.ceil(exponentialMs / 1000);
}

function extractMessageMeta(result: TelegramMessage | true, fallback: StatusMessageRef): StatusMessageRef {
  if (result === true) {
    return fallback;
  }
  const messageId = typeof result.message_id === "number" ? result.message_id : fallback.messageId;
  const chatId =
    result.chat?.id != null && String(result.chat.id).trim()
      ? String(result.chat.id)
      : fallback.chatId;
  return {
    chatId,
    messageId,
    updatedAt: Date.now(),
  };
}

export class TelegramTransport {
  private readonly api: OpenClawPluginApi;
  private readonly config: StatusbarPluginConfig;

  constructor(options: TelegramTransportOptions) {
    this.api = options.api;
    this.config = options.config;
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

  private async callTelegram<T>(params: {
    token: string;
    method: string;
    payload: Record<string, unknown>;
  }): Promise<T> {
    const baseDelayMs = Math.max(this.config.minThrottleMs, 500);
    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${params.token}/${params.method}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(params.payload),
        });

        const parsed = (await response.json()) as TelegramApiResponse<T>;
        if (parsed.ok) {
          return parsed.result;
        }

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

        if (apiError.isMessageNotModified()) {
          throw apiError;
        }

        if (attempt >= this.config.maxRetries) {
          throw apiError;
        }

        if (apiError.isRateLimit()) {
          const retryAfterSec = extractRetryAfterSeconds(apiError, baseDelayMs, attempt);
          const sleepMs = Math.max(250, retryAfterSec * 1000 + resolveJitterMs());
          await sleep(sleepMs);
          attempt += 1;
          continue;
        }

        // Retry 5xx and transient network errors.
        if (apiError.code == null || apiError.code >= 500) {
          const sleepMs = Math.max(250, baseDelayMs * Math.max(1, 2 ** attempt) + resolveJitterMs());
          await sleep(sleepMs);
          attempt += 1;
          continue;
        }

        throw apiError;
      }
    }
  }

  async sendStatusMessage(params: {
    target: TelegramTarget;
    text: string;
    buttons?: TelegramInlineButtons;
  }): Promise<StatusMessageRef> {
    const token = this.resolveToken(params.target.accountId);
    const payload: Record<string, unknown> = {
      chat_id: params.target.chatId,
      text: params.text,
    };
    if (params.target.threadId != null) {
      payload.message_thread_id = params.target.threadId;
    }
    if (params.buttons !== undefined) {
      payload.reply_markup = {
        inline_keyboard: params.buttons,
      };
    }

    const result = await this.callTelegram<TelegramMessage>({
      token,
      method: "sendMessage",
      payload,
    });
    const messageId = typeof result.message_id === "number" ? result.message_id : null;
    const chatId = result.chat?.id != null ? String(result.chat.id) : params.target.chatId;
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
    const token = this.resolveToken(params.target.accountId);
    const payload: Record<string, unknown> = {
      chat_id: params.message.chatId,
      message_id: params.message.messageId,
      text: params.text,
    };
    if (params.buttons !== undefined) {
      payload.reply_markup = {
        inline_keyboard: params.buttons,
      };
    }

    try {
      const result = await this.callTelegram<TelegramMessage | true>({
        token,
        method: "editMessageText",
        payload,
      });
      return extractMessageMeta(result, params.message);
    } catch (err) {
      if (err instanceof TelegramApiError && err.isMessageNotModified()) {
        return {
          ...params.message,
          updatedAt: Date.now(),
        };
      }
      throw err;
    }
  }
}
