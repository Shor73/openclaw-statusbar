import type { ConversationPrefs, SessionRuntime } from "./types.js";

/**
 * Statusbar render module — v0.3.0
 *
 * Design principles:
 * - Show only real, verifiable information (no invented step counts)
 * - Time-based progress is more reliable than step-based
 * - Clean, compact output optimized for Telegram inline display
 * - Phase-appropriate rendering: active runs show detail, done shows summary
 */

// --- Progress estimation constants ---

/** Weight of step-based ratio in blended progress (0–1) */
const PROGRESS_STEP_WEIGHT = 0.4;
/** Weight of time-based ratio in blended progress (0–1) */
const PROGRESS_TIME_WEIGHT = 0.6;
/** Minimum progress ratio to avoid showing 0% */
const PROGRESS_MIN_RATIO = 0.01;
/** Maximum progress ratio during active run (never show 100% until done) */
const PROGRESS_MAX_RATIO = 0.99;
/** Minimum displayable percent */
const PROGRESS_MIN_PERCENT = 1;
/** Maximum displayable percent during active run */
const PROGRESS_MAX_PERCENT = 99;
/** Minimum ratio before attempting ETA calculation (avoids wild estimates at start) */
const ETA_MIN_RATIO_THRESHOLD = 0.08;
/** Fallback assumed total steps when no history exists */
const FALLBACK_STEPS_TOTAL = 4;
/** Minimum elapsed time (ms) before showing ETA (avoid noisy early estimates) */
const ETA_MIN_ELAPSED_MS = 3000;

// --- Formatters ---

function formatClockMs(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function getElapsedMs(session: SessionRuntime): number {
  const endMs = session.endedAtMs ?? Date.now();
  return Math.max(0, endMs - session.startedAtMs);
}

// --- Phase display ---

function resolveStatusIcon(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":  return "⏳";
    case "running": return "⚡";
    case "tool":    return "🔧";
    case "done":    return "✅";
    case "error":   return "❌";
    default:        return "💤";
  }
}

function resolveFocusLabel(session: SessionRuntime): string {
  if (session.phase === "tool" && session.toolName) return session.toolName;
  if (session.phase === "queued")  return "in coda";
  if (session.phase === "running") return "elaboro";
  if (session.phase === "done")    return "completato";
  if (session.phase === "error")   return "errore";
  return "idle";
}

// --- Progress estimation ---

/**
 * Computes progress based on a time+step blend.
 * Step counts are used internally for ratio estimation but NOT displayed to the user.
 * The displayed progress is percentage and ETA only.
 */
function resolveProgress(
  session: SessionRuntime,
  prefs: ConversationPrefs,
): {
  percent: number | null;
  etaMs: number | null;
} {
  const isFinal = session.phase === "done" || session.phase === "error";
  const elapsedMs = getElapsedMs(session);

  // Final states: always 100%, ETA 0
  if (isFinal) {
    return { percent: 100, etaMs: 0 };
  }

  // Strict mode: no estimation during run, only show done/not-done
  if (prefs.progressMode === "strict") {
    return { percent: null, etaMs: null };
  }

  // --- Predictive mode ---
  const rawStepsDone = Math.max(0, session.currentRunSteps);

  // Step-based ratio (internal only, never displayed as X/Y)
  const historyTotal =
    prefs.historyRuns > 0 ? Math.round(Math.max(1, prefs.avgSteps)) : 0;
  const estimatedTotal = Math.max(
    historyTotal || FALLBACK_STEPS_TOTAL,
    rawStepsDone + 1,
  );
  const stepRatio = estimatedTotal > 0 ? rawStepsDone / estimatedTotal : 0;

  let percentRatio = Math.max(PROGRESS_MIN_RATIO, stepRatio);
  let etaMs: number | null = null;

  if (prefs.avgDurationMs > 0) {
    // Blend step-based and time-based progress
    const timeRatio = Math.min(PROGRESS_MAX_RATIO, elapsedMs / prefs.avgDurationMs);
    percentRatio = Math.max(
      stepRatio,
      Math.min(
        PROGRESS_MAX_RATIO,
        stepRatio * PROGRESS_STEP_WEIGHT + timeRatio * PROGRESS_TIME_WEIGHT,
      ),
    );
    // ETA from historical average duration
    if (elapsedMs >= ETA_MIN_ELAPSED_MS) {
      etaMs = Math.max(0, Math.round(prefs.avgDurationMs - elapsedMs));
    }
  } else if (percentRatio > ETA_MIN_RATIO_THRESHOLD && elapsedMs >= ETA_MIN_ELAPSED_MS) {
    // Fallback ETA from current pace
    etaMs = Math.max(0, Math.round((elapsedMs * (1 - percentRatio)) / percentRatio));
  }

  return {
    percent: Math.max(
      PROGRESS_MIN_PERCENT,
      Math.min(PROGRESS_MAX_PERCENT, Math.round(percentRatio * 100)),
    ),
    etaMs,
  };
}

// --- Render layouts ---

/**
 * Compact single-line statusbar.
 *
 * Active:  ⚡ elaboro #5 | 00:15 | 35% | ETA 00:28
 * Tool:    🔧 exec #5 | 00:23 | 52% | ETA 00:21
 * Done:    ✅ completato #5 | 00:31
 * Error:   ❌ errore #5 | 00:31
 * Queued:  ⏳ in coda #5
 * Idle:    💤 idle
 */
function renderTiny1(session: SessionRuntime, prefs: ConversationPrefs): string {
  const icon = resolveStatusIcon(session);
  const focus = resolveFocusLabel(session);
  const taskLabel = session.runNumber > 0 ? `#${session.runNumber}` : "";
  const pinMarker = prefs.pinMode ? " 📌" : "";
  const elapsed = formatClockMs(getElapsedMs(session));

  // Idle: minimal
  if (session.phase === "idle") {
    return `${icon} idle`;
  }

  // Queued: just show queued status
  if (session.phase === "queued") {
    return `${icon} ${focus} ${taskLabel}${pinMarker}`;
  }

  // Done/Error: clean summary with total time only
  if (session.phase === "done" || session.phase === "error") {
    return `${icon} ${focus} ${taskLabel}${pinMarker} | ${elapsed}`;
  }

  // Active (running/tool): show progress details
  const progress = resolveProgress(session, prefs);
  const parts: string[] = [
    `${icon} ${focus} ${taskLabel}${pinMarker}`,
    elapsed,
  ];

  if (progress.percent != null) {
    parts.push(`${progress.percent}%`);
  }
  if (progress.etaMs != null) {
    parts.push(`ETA ${formatClockMs(progress.etaMs)}`);
  }

  return parts.join(" | ");
}

// --- Public API ---

export function renderStatusText(session: SessionRuntime, prefs: ConversationPrefs): string {
  return renderTiny1(session, prefs);
}
