import { readFileSync, writeFileSync } from "node:fs";
import type { RunPhase } from "./types.js";

const STATE_FILE = "/tmp/statusbar-runs.json";

/**
 * Shared run state — lives on disk so both [gateway] and [plugins] instances see it.
 * This is the ONLY source of truth for run lifecycle. No more in-memory divergence.
 */
export type SharedRunState = {
  phase: RunPhase;
  startedAtMs: number;
  endedAtMs: number | null;
  steps: number;
  predictedSteps: number;
  toolName: string | null;
  model: string | null;
  provider: string | null;
  usageInput: number | null;
  usageOutput: number | null;
  thinkingLevel: string | null;
  error: string | null;
  runNumber: number;
  queuedCount: number;
  compacting: boolean;
  /** Instance that last wrote state — only this instance renders */
  writerInstanceId: string;
  updatedAtMs: number;
};

type StateFile = Record<string, SharedRunState>;

export function makeDefaultSharedState(instanceId: string): SharedRunState {
  return {
    phase: "idle",
    startedAtMs: Date.now(),
    endedAtMs: null,
    steps: 0,
    predictedSteps: 0,
    toolName: null,
    model: null,
    provider: null,
    usageInput: null,
    usageOutput: null,
    thinkingLevel: null,
    error: null,
    runNumber: 0,
    queuedCount: 0,
    compacting: false,
    writerInstanceId: instanceId,
    updatedAtMs: Date.now(),
  };
}

export class SharedState {
  private cache: StateFile | null = null;
  private cacheAtMs = 0;
  private static readonly CACHE_TTL_MS = 200; // avoid disk thrashing on rapid reads

  private readRaw(): StateFile {
    try {
      const raw = readFileSync(STATE_FILE, "utf8");
      return JSON.parse(raw) as StateFile;
    } catch {
      return {};
    }
  }

  read(): StateFile {
    const now = Date.now();
    if (this.cache && now - this.cacheAtMs < SharedState.CACHE_TTL_MS) {
      return this.cache;
    }
    this.cache = this.readRaw();
    this.cacheAtMs = now;
    return this.cache;
  }

  private write(data: StateFile): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(data), "utf8");
      this.cache = data;
      this.cacheAtMs = Date.now();
    } catch { /* ignore write errors — /tmp/ should always be writable */ }
  }

  get(key: string): SharedRunState | null {
    return this.read()[key] ?? null;
  }

  set(key: string, state: SharedRunState): void {
    const data = this.readRaw(); // bypass cache for writes
    data[key] = state;
    this.write(data);
  }

  update(key: string, updater: (current: SharedRunState | null) => SharedRunState | null): SharedRunState | null {
    const data = this.readRaw();
    const current = data[key] ?? null;
    const result = updater(current);
    if (result === null) {
      delete data[key];
    } else {
      data[key] = result;
    }
    this.write(data);
    return result;
  }

  delete(key: string): void {
    const data = this.readRaw();
    delete data[key];
    this.write(data);
  }

  /** Remove entries older than maxAgeMs */
  prune(maxAgeMs: number): void {
    const data = this.readRaw();
    const now = Date.now();
    let changed = false;
    for (const [key, state] of Object.entries(data)) {
      if (now - state.updatedAtMs > maxAgeMs) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) this.write(data);
  }

  clear(): void {
    this.write({});
  }
}
