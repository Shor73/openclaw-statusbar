import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type {
  ConversationPrefs,
  PersistedStore,
  StatusMessageRef,
  StatusMode,
  TelegramTarget,
} from "./types.js";

const STORE_FILE = path.join("plugins", "statusbar", "state.json");

function defaultConversation(enabledByDefault: boolean, mode: StatusMode): ConversationPrefs {
  return {
    enabled: enabledByDefault,
    mode,
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
    const loaded = await readJsonFileWithFallback<PersistedStore>(this.filePath, fallback);
    if (!loaded.value || typeof loaded.value !== "object") {
      this.data = fallback;
      return;
    }
    this.data = {
      version: 1,
      conversations:
        typeof loaded.value.conversations === "object" && loaded.value.conversations
          ? loaded.value.conversations
          : {},
    };
  }

  getConversation(target: Pick<TelegramTarget, "accountId" | "conversationId">): ConversationPrefs {
    const key = resolveConversationKey(target);
    const existing = this.data.conversations[key];
    if (existing) {
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
    await writeJsonFileAtomically(this.filePath, this.data);
  }
}
