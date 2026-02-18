import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConversationPrefs,
  PersistedStore,
  StatusMessageRef,
  StatusMode,
  TelegramTarget,
} from "./types.js";

const STORE_FILE = path.join("plugins", "openclaw-statusbar", "state.json");

function defaultConversation(enabledByDefault: boolean, mode: StatusMode): ConversationPrefs {
  return {
    enabled: enabledByDefault,
    mode,
    pinMode: false,
    statusMessagesByThread: {},
    updatedAt: Date.now(),
  };
}

export function resolveConversationKey(target: Pick<TelegramTarget, "accountId" | "conversationId">): string {
  return `${target.accountId}::${target.conversationId}`;
}

export function resolveThreadKey(threadId: number | null): string {
  return threadId == null ? "main" : String(threadId);
}

export function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILE);
}

async function readStoreFile(filePath: string): Promise<PersistedStore | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedStore;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeStoreFile(filePath: string, data: PersistedStore): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export class StatusbarStore {
  private readonly filePath: string;
  private readonly enabledByDefault: boolean;
  private readonly defaultMode: StatusMode;
  private data: PersistedStore = { version: 1, conversations: {} };

  constructor(params: { stateDir: string; enabledByDefault: boolean; defaultMode: StatusMode }) {
    this.filePath = resolveStorePath(params.stateDir);
    this.enabledByDefault = params.enabledByDefault;
    this.defaultMode = params.defaultMode;
  }

  async load(): Promise<void> {
    const fallback: PersistedStore = { version: 1, conversations: {} };
    const loaded = await readStoreFile(this.filePath);
    if (!loaded || typeof loaded !== "object") {
      this.data = fallback;
      return;
    }
    this.data = {
      version: 1,
      conversations:
        typeof loaded.conversations === "object" && loaded.conversations
          ? loaded.conversations
          : {},
    };
  }

  getConversation(target: Pick<TelegramTarget, "accountId" | "conversationId">): ConversationPrefs {
    const key = resolveConversationKey(target);
    const existing = this.data.conversations[key];
    if (existing) {
      if (typeof existing.enabled !== "boolean") {
        existing.enabled = this.enabledByDefault;
      }
      if (existing.mode !== "minimal" && existing.mode !== "normal" && existing.mode !== "detailed") {
        existing.mode = this.defaultMode;
      }
      if (typeof existing.pinMode !== "boolean") {
        existing.pinMode = false;
      }
      if (
        typeof existing.statusMessagesByThread !== "object" ||
        existing.statusMessagesByThread == null
      ) {
        existing.statusMessagesByThread = {};
      }
      return existing;
    }
    const next = defaultConversation(this.enabledByDefault, this.defaultMode);
    this.data.conversations[key] = next;
    return next;
  }

  updateConversation(
    target: Pick<TelegramTarget, "accountId" | "conversationId">,
    updater: (current: ConversationPrefs) => ConversationPrefs,
  ): ConversationPrefs {
    const key = resolveConversationKey(target);
    const current = this.getConversation(target);
    const updated = {
      ...updater(current),
      updatedAt: Date.now(),
    };
    this.data.conversations[key] = updated;
    return updated;
  }

  getStatusMessage(target: TelegramTarget): StatusMessageRef | null {
    const prefs = this.getConversation(target);
    const ref = prefs.statusMessagesByThread[resolveThreadKey(target.threadId)];
    return ref ?? null;
  }

  setStatusMessage(target: TelegramTarget, ref: StatusMessageRef | null): void {
    this.updateConversation(target, (current) => {
      const next = { ...current, statusMessagesByThread: { ...current.statusMessagesByThread } };
      const threadKey = resolveThreadKey(target.threadId);
      if (ref == null) {
        delete next.statusMessagesByThread[threadKey];
      } else {
        next.statusMessagesByThread[threadKey] = ref;
      }
      return next;
    });
  }

  async persist(): Promise<void> {
    await writeStoreFile(this.filePath, this.data);
  }

  findMostRecentTargetForAccount(accountId: string): TelegramTarget | null {
    const normalizedAccount = accountId.trim();
    if (!normalizedAccount) {
      return null;
    }

    let best: { conversationId: string; updatedAt: number } | null = null;
    for (const [key, prefs] of Object.entries(this.data.conversations)) {
      if (!key.startsWith(`${normalizedAccount}::`)) {
        continue;
      }
      const conversationId = key.slice(`${normalizedAccount}::`.length);
      if (!conversationId || !conversationId.startsWith("telegram:")) {
        continue;
      }
      const updatedAt =
        typeof prefs.updatedAt === "number" && Number.isFinite(prefs.updatedAt) ? prefs.updatedAt : 0;
      if (!best || updatedAt > best.updatedAt) {
        best = { conversationId, updatedAt };
      }
    }

    if (!best) {
      return null;
    }

    const chatId = best.conversationId.slice("telegram:".length).trim();
    if (!chatId) {
      return null;
    }

    return {
      channelId: "telegram",
      accountId: normalizedAccount,
      conversationId: best.conversationId,
      chatId,
      threadId: null,
    };
  }
}
