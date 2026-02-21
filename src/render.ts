import type { ConversationPrefs, SessionRuntime } from "./types.js";

// fix #12: magic numbers → costanti nominate
const PROGRESS_STEP_WEIGHT    = 0.6;
const PROGRESS_TIME_WEIGHT    = 0.4;
const PROGRESS_MIN_RATIO      = 0.01;
const PROGRESS_MAX_RATIO      = 0.99;
const PROGRESS_MIN_PERCENT    = 1;
const PROGRESS_MAX_PERCENT    = 99;
const ETA_MIN_RATIO_THRESHOLD = 0.05;
const FALLBACK_STEPS_TOTAL    = 4;

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

function resolveStatusLabel(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":  return "QUEUED";
    case "running": return "RUNNING";
    case "tool":    return "TOOL";
    case "done":    return "DONE";
    case "error":   return "ERROR";
    default:        return "IDLE";
  }
}

function resolveStatusIcon(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":  return "⏳";
    case "running": return "⚡";
    case "tool":    return "🛠️";
    case "done":    return "✅";
    case "error":   return "❌";
    default:        return "💤";
  }
}

function resolveFocusLabel(session: SessionRuntime): string {
  if (session.phase === "tool" && session.toolName) return session.toolName;
  if (session.phase === "queued")  return "queue";
  if (session.phase === "running") return "thinking";
  if (session.phase === "done")    return "done";
  if (session.phase === "error")   return "error";
  return "idle";
}

function resolveProgress(
  session: SessionRuntime,
  prefs: ConversationPrefs,
): {
  stepsDone: number;
  stepsTotal: number | null;
  percent: number | null;
  etaMs: number | null;
} {
  const isFinal = session.phase === "done" || session.phase === "error";
  const elapsedMs = getElapsedMs(session);
  const rawStepsDone = Math.max(0, session.currentRunSteps);
  const stepsDone = isFinal ? Math.max(1, rawStepsDone) : rawStepsDone;

  if (prefs.progressMode === "strict") {
    return {
      stepsDone,
      stepsTotal: isFinal ? Math.max(1, stepsDone) : null,
      percent:    isFinal ? 100 : null,
      etaMs:      isFinal ? 0   : null,
    };
  }

  const historyTotal =
    prefs.historyRuns > 0 ? Math.round(Math.max(1, prefs.avgSteps)) : 0;
  const stepsTotal = Math.max(
    historyTotal || FALLBACK_STEPS_TOTAL,
    stepsDone + (isFinal ? 0 : 1),
  );

  if (isFinal) {
    return {
      stepsDone,
      stepsTotal: Math.max(stepsTotal, stepsDone),
      percent: 100,
      etaMs: 0,
    };
  }

  const stepRatio = stepsTotal > 0 ? stepsDone / stepsTotal : 0;
  let percentRatio = Math.max(PROGRESS_MIN_RATIO, stepRatio);
  let etaMs: number | null = null;

  if (prefs.avgDurationMs > 0) {
    const timeRatio = Math.min(PROGRESS_MAX_RATIO, elapsedMs / prefs.avgDurationMs);
    percentRatio = Math.max(
      stepRatio,
      Math.min(
        PROGRESS_MAX_RATIO,
        stepRatio * PROGRESS_STEP_WEIGHT + timeRatio * PROGRESS_TIME_WEIGHT,
      ),
    );
    etaMs = Math.max(0, Math.round(prefs.avgDurationMs - elapsedMs));
  } else if (percentRatio > ETA_MIN_RATIO_THRESHOLD) {
    etaMs = Math.max(0, Math.round((elapsedMs * (1 - percentRatio)) / percentRatio));
  }

  return {
    stepsDone,
    stepsTotal,
    percent: Math.max(
      PROGRESS_MIN_PERCENT,
      Math.min(PROGRESS_MAX_PERCENT, Math.round(percentRatio * 100)),
    ),
    etaMs,
  };
}

function renderTiny1(session: SessionRuntime, prefs: ConversationPrefs): string {
  const statusLabel = resolveStatusLabel(session);
  const statusIcon  = resolveStatusIcon(session);
  const taskLabel   = session.runNumber > 0 ? `#${session.runNumber}` : "#-";
  const pinMarker   = prefs.pinMode ? "📌" : "";
  const focusLabel  = resolveFocusLabel(session);
  const elapsed     = formatClockMs(getElapsedMs(session));
  const progress    = resolveProgress(session, prefs);

  const stepsText =
    progress.stepsTotal == null
      ? `${progress.stepsDone}/?`
      : `${progress.stepsDone}/${progress.stepsTotal}`;
  const percentText = progress.percent == null ? "--" : `${progress.percent}%`;
  const etaText     = progress.etaMs  == null ? "--" : formatClockMs(progress.etaMs);

  return `${statusIcon} ${statusLabel} ${taskLabel}${pinMarker} | ${focusLabel} | ${elapsed} | ${stepsText} | ${percentText} | ETA ${etaText}`;
}

export function renderStatusText(session: SessionRuntime, prefs: ConversationPrefs): string {
  return renderTiny1(session, prefs);
}

// fix #11: buildEnabledControls e buildDisabledControls rimossi — erano dead code ([] sempre)
