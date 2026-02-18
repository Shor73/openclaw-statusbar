import type { StatusMode, StatusbarPluginConfig } from "./types.js";

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function asMode(value: unknown, fallback: StatusMode): StatusMode {
  if (value === "minimal" || value === "normal" || value === "detailed") {
    return value;
  }
  return fallback;
}

export function normalizePluginConfig(raw: unknown): StatusbarPluginConfig {
  const source = typeof raw === "object" && raw != null ? (raw as Record<string, unknown>) : {};
  return {
    enabledByDefault: asBool(source.enabledByDefault, false),
    defaultMode: asMode(source.defaultMode, "normal"),
    throttleMs: asInt(source.throttleMs, 3200, 250, 10_000),
    minThrottleMs: asInt(source.minThrottleMs, 2500, 250, 10_000),
    maxRetries: asInt(source.maxRetries, 4, 0, 10),
    autoHideSeconds: asInt(source.autoHideSeconds, 0, 0, 600),
    showInlineControls: asBool(source.showInlineControls, true),
  };
}
