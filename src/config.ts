import type { ProgressMode, StatusLayout, StatusMode, StatusbarPluginConfig } from "./types.js";

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function asMode(value: unknown, fallback: StatusMode): StatusMode {
  if (value === "minimal" || value === "normal" || value === "detailed") return value;
  return fallback;
}

function asLayout(value: unknown, fallback: StatusLayout): StatusLayout {
  if (value === "tiny1") return value;
  return fallback;
}

function asProgressMode(value: unknown, fallback: ProgressMode): ProgressMode {
  if (value === "strict" || value === "predictive") return value;
  return fallback;
}

export function normalizePluginConfig(raw: unknown): StatusbarPluginConfig {
  const source = typeof raw === "object" && raw != null ? (raw as Record<string, unknown>) : {};
  return {
    enabledByDefault: asBool(source.enabledByDefault, false),
    defaultMode: asMode(source.defaultMode, "normal"),
    defaultLayout: asLayout(source.defaultLayout, "tiny1"),
    defaultProgressMode: asProgressMode(source.defaultProgressMode, "predictive"),
    // fix #18: defaults alzati per stare sotto il limite Telegram (~20 edit/min per sessione)
    throttleMs:    asInt(source.throttleMs,    4000, 250, 10_000),
    minThrottleMs: asInt(source.minThrottleMs, 2500, 250, 10_000),
    liveTickMs:    asInt(source.liveTickMs,    2500, 250, 10_000),
    // fix #20: edit efimeri → 0 retry; send/pin critici → 4 retry
    maxRetriesEdit: asInt(source.maxRetriesEdit, 0, 0, 4),
    maxRetriesSend: asInt(source.maxRetriesSend, 4, 0, 10),
    autoHideSeconds: asInt(source.autoHideSeconds, 0, 0, 600),
    showInlineControls: asBool(source.showInlineControls, false),
    newMessagePerRun: asBool(source.newMessagePerRun, true),
  };
}
