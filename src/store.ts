import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConversationPrefs,
  ProgressMode,
  PersistedStore,
  StatusLayout,
  StatusMessageRef,
  StatusMode,
  TelegramTarget,
} from "./types.js";

const STORE_FILE = path.join("plugins", "openclaw-statusbar", "state.json");

function defaultConversation(
  enabledByDefault: boolean,
  mode: StatusMode,
  layout: StatusLayout,
  progressMode: ProgressMode,
): ConversationPrefs {
  return {
    enabled: enabledByDefault,
    mode,
    layout,
    progressMode,
    pinMode: false,
    historyRuns: 0,
    avgDurationMs: 0,
    avgSteps: 0,
    statusMessagesByThread: {},
    updatedAt: Date.now(),
  };
}

// fix #8: funzione pura di migrazione — nessuna mutazione in-place del record esistente
function migrateConversationPrefs(
  raw: ConversationPrefs,
  defaults: {
    enabledByDefault: boolean;
    defaultMode: StatusMode;
    defaultLayout: StatusLayout;
    defaultProgressMode: ProgressMode;
  },
): ConversationPrefs {
  return {
    ...raw,
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabledByDefault,
    mode:
      raw.mode === "minimal" || raw.mode === "normal" || raw.mode === "detailed"
        ? raw.mode
        : defaults.defaultMode,
    layout: raw.layout === "tiny1" ? raw.layout : defaults.defaultLayout,
    progressMode:
      raw.progressMode === "strict" || raw.progressMode === "predictive"
        ? raw.progressMode
        : defaults.defaultProgressMode,
    pinMode: typeof raw.pinMode === "boolean" ? raw.pinMode : false,
    historyRuns:
      typeof raw.historyRuns === "number" && Number.isFinite(raw.historyRuns)
        ? raw.historyRuns
        : 0,
    avgDurationMs:
      typeof raw.avgDurationMs === "number" && Number.isFinite(raw.avgDurationMs)
        ? raw.avgDurationMs
        : 0,
    avgSteps:
      typeof raw.avgSteps === "number" && Number.isFinite(raw.avgSteps)
        ? raw.avgSteps
        : 0,
    statusMessagesByThread:
      typeof raw.statusMessagesByThread === "object" && raw.statusMessagesByThread != null
        ? raw.statusMessagesByThread
        : {},
  };
}

export function resolveConversationKey(
  target: Pick<TelegramTarget, "accountId" | "conversationId">,
): string {
  return `${target.accountId}::${target.conversationId}`;
}

export function resolveThreadKey(threadId: number | null): string {
  return threadId == null ? "main" : String(threadId);
}

export function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILE);
}

// fix #10: distingue ENOENT (normale) da corruzione JSON (da loggare)
async function readStoreFile(
  filePath: string,
  log?: (msg: string) => void,
): Promise<PersistedStore | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedStore;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`statusbar: store read error (possible corruption): ${String(err)}`);
    }
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
  private readonly defaultLayout: StatusLayout;
  private readonly defaultProgressMode: ProgressMode;
  private readonly log: ((msg: string) => void) | undefined;
  private data: PersistedStore = { version: 1, conversations: {} };

  // fix #3: write queue — serializza le scritture su disco per evitare corruzione
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(params: {
    stateDir: string;
    enabledByDefault: boolean;
    defaultMode: StatusMode;
    defaultLayout: StatusLayout;
    defaultProgressMode: ProgressMode;
    log?: (msg: string) => void;
  }) {
    this.filePath             = resolveStorePath(params.stateDir);
    this.enabledByDefault     = params.enabledByDefault;
    this.defaultMode          = params.defaultMode;
    this.defaultLayout        = params.defaultLayout;
    this.defaultProgressMode  = params.defaultProgressMode;
    this.log                  = params.log;
  }

  async load(): Promise<void> {
    // fix #15: verifica la versione e predispone punto di migrazione per versioni future
    const loaded = await readStoreFile(this.filePath, this.log);
    if (!loaded || typeof loaded !== "object") {
      this.data = { version: 1, conversations: {} };
      return;
    }
    if (loaded.version !== 1) {
      this.log?.(
        `statusbar: unknown store version ${String(loaded.version)}, resetting to empty state`,
      );
      this.data = { version: 1, conversations: {} };
      await this.persist();
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

  getConversation(
    target: Pick<TelegramTarget, "accountId" | "conversationId">,
  ): ConversationPrefs {
    const key = resolveConversationKey(target);
    const existing = this.data.conversations[key];
    if (existing) {
      // fix #8: usa funzione pura invece di mutare il record in-place
      const migrated = migrateConversationPrefs(existing, {
        enabledByDefault:    this.enabledByDefault,
        defaultMode:         this.defaultMode,
        defaultLayout:       this.defaultLayout,
        defaultProgressMode: this.defaultProgressMode,
      });
      this.data.conversations[key] = migrated;
      return migrated;
    }
    const next = defaultConversation(
      this.enabledByDefault,
      this.defaultMode,
      this.defaultLayout,
      this.defaultProgressMode,
    );
    this.data.conversations[key] = next;
    return next;
  }

  updateConversation(
    target: Pick<TelegramTarget, "accountId" | "conversationId">,
    updater: (current: ConversationPrefs) => ConversationPrefs,
  ): ConversationPrefs {
    const key     = resolveConversationKey(target);
    const current = this.getConversation(target);
    const updated = { ...updater(current), updatedAt: Date.now() };
    this.data.conversations[key] = updated;
    return updated;
  }

  getStatusMessage(target: TelegramTarget): StatusMessageRef | null {
    const prefs = this.getConversation(target);
    return prefs.statusMessagesByThread[resolveThreadKey(target.threadId)] ?? null;
  }

  setStatusMessage(target: TelegramTarget, ref: StatusMessageRef | null): void {
    this.updateConversation(target, (current) => {
      const next      = { ...current, statusMessagesByThread: { ...current.statusMessagesByThread } };
      const threadKey = resolveThreadKey(target.threadId);
      if (ref == null) {
        delete next.statusMessagesByThread[threadKey];
      } else {
        next.statusMessagesByThread[threadKey] = ref;
      }
      return next;
    });
  }

  // fix #3: scritture serializzate tramite promise chain — previene corruzione da write concorrenti
  async persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(() =>
      writeStoreFile(this.filePath, this.data).catch((err) => {
        this.log?.(`statusbar: persist failed: ${String(err)}`);
      }),
    );
    return this.persistQueue;
  }

  findMostRecentTargetForAccount(accountId: string): TelegramTarget | null {
    const normalizedAccount = accountId.trim();
    if (!normalizedAccount) return null;

    let best: { conversationId: string; updatedAt: number } | null = null;
    for (const [key, prefs] of Object.entries(this.data.conversations)) {
      if (!key.startsWith(`${normalizedAccount}::`)) continue;
      const conversationId = key.slice(`${normalizedAccount}::`.length);
      if (!conversationId || !conversationId.startsWith("telegram:")) continue;
      const updatedAt =
        typeof prefs.updatedAt === "number" && Number.isFinite(prefs.updatedAt)
          ? prefs.updatedAt
          : 0;
      if (!best || updatedAt > best.updatedAt) {
        best = { conversationId, updatedAt };
      }
    }

    if (!best) return null;

    const chatId = best.conversationId.slice("telegram:".length).trim();
    if (!chatId) return null;

    return {
      channelId: "telegram",
      accountId: normalizedAccount,
      conversationId: best.conversationId,
      chatId,
      threadId: null,
    };
  }
}
