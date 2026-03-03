import type { ConversationPrefs, SessionRuntime } from "./types.js";

/**
 * Statusbar render module — v0.4.0 (geek edition)
 *
 * Layouts:
 * - minimal:  icon + focus + time
 * - normal:   icon + focus + progress bar + % + time
 * - detailed: icon + focus + model + progress bar + % + time + ETA + tokens
 */

// --- Progress estimation constants ---
const PROGRESS_STEP_WEIGHT = 0.4;
const PROGRESS_TIME_WEIGHT = 0.6;
const PROGRESS_MIN_RATIO = 0.01;
const PROGRESS_MAX_RATIO = 0.99;
const PROGRESS_MIN_PERCENT = 1;
const PROGRESS_MAX_PERCENT = 99;
const ETA_MIN_RATIO_THRESHOLD = 0.08;
const FALLBACK_STEPS_TOTAL = 4;
const ETA_MIN_ELAPSED_MS = 3000;
const ETA_ACTIVE_FLOOR_MS = 1000;      // sotto questa soglia → bump predicted end

// --- Progress bar config ---
const BAR_WIDTH = 7;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";

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

function formatCompactSeconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function formatTokens(input: number | null, output: number | null): string | null {
  if ((input == null || input === 0) && (output == null || output === 0)) return null;
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  const inStr = input ? fmt(input) : "0";
  const outStr = output ? fmt(output) : "0";
  return `${inStr}↑${outStr}↓`;
}

const DEFAULT_MODEL_LABEL = "opus-4.6";
const DEFAULT_THINKING = "high";

const MODEL_PATTERNS: [RegExp, string][] = [
  [/glm[-_]?(\d[\d.]*)/, "glm"],
  [/opus[-_]?(\d[\d.\-]*)/, "opus"],
  [/sonnet[-_]?(\d[\d.\-]*)/, "sonnet"],
  [/haiku[-_]?(\d[\d.\-]*)/, "haiku"],
  [/gpt[-_]?(\d[\d.]*)/, "gpt"],
  [/llama[-_]?(\d[\d.]*)/, "llama"],
  [/minimax/, "minimax"],
  [/gemini[-_]?(\d[\d.]*)/, "gemini"],
  [/deepseek/, "deepseek"],
];

function shortModel(model: string | null, fallback = false): string | null {
  if (!model) return fallback ? DEFAULT_MODEL_LABEL : null;
  const m = model.toLowerCase().replace(/_/g, "-"); // normalize
  for (const [pattern, label] of MODEL_PATTERNS) {
    const match = m.match(pattern);
    if (match) {
      const version = match[1] ? `-${match[1].replace(/-/g, ".")}` : "";
      return `${label}${version}`;
    }
  }
  // fallback: last segment
  return m.split("/").pop()?.split("-").slice(0, 2).join("-") ?? m;
}

function getElapsedMs(session: SessionRuntime): number {
  const endMs = session.endedAtMs ?? Date.now();
  return Math.max(0, endMs - session.startedAtMs);
}

// --- Progress bar ---

function renderProgressBar(percent: number | null): string {
  if (percent == null) return BAR_EMPTY.repeat(BAR_WIDTH);
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
}

// --- Phase display ---

const TOOL_ICONS: Record<string, string> = {
  exec: "🖥", Read: "📖", read: "📖",
  Write: "✏️", write: "✏️", Edit: "🔏", edit: "🔏",
  process: "⏱️", web_search: "🔍", web_fetch: "🌐",
  browser: "🌐", message: "💬", gateway: "🔌",
  canvas: "🎨", nodes: "🔗", cron: "⏰",
  sessions_spawn: "🧬", sessions_send: "📤",
  subagents: "🤖", session_status: "📋",
  image: "🖼", memory_search: "🧠", memory_get: "🧠",
  tts: "🔊",
};

function resolveStatusIcon(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":   return "🔜";
    case "running":  return "💭";
    case "thinking": return "💭";
    case "tool":     return (session.toolName && TOOL_ICONS[session.toolName]) || "🔧";
    case "sending":  return "📤";
    case "done":     return "🟢";
    case "error":    return "❌";
    default:         return "💤";
  }
}

function resolveFocusLabel(session: SessionRuntime): string {
  if (session.phase === "tool" && session.toolName) return session.toolName;
  if (session.phase === "queued")   return "in coda";
  if (session.phase === "running")  return "thinking";
  if (session.phase === "thinking") return "thinking";
  if (session.phase === "sending")  return "sending";
  if (session.phase === "done")     return "done";
  if (session.phase === "error")    return "errore";
  return "idle";
}

// --- Private ETA state (render-local, not on SessionRuntime) ---
const etaState = new Map<string, { predictedEndMs: number; etaSteps: number }>();

// --- Progress estimation ---


function resolveProgress(
  session: SessionRuntime,
  prefs: ConversationPrefs,
): { percent: number | null; etaMs: number | null } {
  const isFinal = session.phase === "done" || session.phase === "error";
  const elapsedMs = getElapsedMs(session);

  if (isFinal) {
    etaState.delete(session.sessionKey);
    return { percent: 100, etaMs: 0 };
  }
  if (prefs.progressMode === "strict") return { percent: null, etaMs: null };

  const rawStepsDone = Math.max(0, session.currentRunSteps);
  const historyTotal = prefs.historyRuns > 0 ? Math.round(Math.max(1, prefs.avgSteps)) : 0;
  // v2.0: usa predictedSteps da llm_output tool_use parse quando disponibile
  const baseTotalSteps = session.predictedSteps > rawStepsDone
    ? session.predictedSteps
    : (historyTotal || FALLBACK_STEPS_TOTAL);
  const estimatedTotal = Math.max(baseTotalSteps, rawStepsDone + 1);
  const stepRatio = estimatedTotal > 0 ? rawStepsDone / estimatedTotal : 0;

  // percentRatio per la barra: blended steps + time
  let percentRatio = Math.max(PROGRESS_MIN_RATIO, stepRatio);
  if (prefs.avgDurationMs > 0) {
    const timeRatio = Math.min(PROGRESS_MAX_RATIO, elapsedMs / prefs.avgDurationMs);
    percentRatio = Math.max(
      stepRatio,
      Math.min(PROGRESS_MAX_RATIO, stepRatio * PROGRESS_STEP_WEIGHT + timeRatio * PROGRESS_TIME_WEIGHT),
    );
  }

  // ETA: predicted end time approach (step-based, NOT time-blended)
  let etaMs: number | null = null;
  if (elapsedMs >= ETA_MIN_ELAPSED_MS) {
    const now = Date.now();
    const prev = etaState.get(session.sessionKey);
    const prevSteps = prev?.etaSteps;
    const predictedEnd = prev?.predictedEndMs;
    const stepsRemaining = Math.max(1, estimatedTotal - rawStepsDone);

    // Velocità media di uno step basata su questo run
    const avgStepMs = rawStepsDone > 0
      ? elapsedMs / rawStepsDone
      : (prefs.avgDurationMs > 0 ? prefs.avgDurationMs / Math.max(1, historyTotal) : 10000);

    if (prevSteps !== rawStepsDone || !predictedEnd) {
      // Nuovo step o primo calcolo: calcola predicted end time
      const newEnd = now + stepsRemaining * avgStepMs;
      etaState.set(session.sessionKey, { predictedEndMs: newEnd, etaSteps: rawStepsDone });
      etaMs = Math.round(newEnd - now);
    } else {
      // Tra step: countdown verso predicted end
      etaMs = Math.round(predictedEnd - now);
      if (etaMs < ETA_ACTIVE_FLOOR_MS) {
        const newEnd = now + stepsRemaining * avgStepMs;
        etaState.set(session.sessionKey, { predictedEndMs: newEnd, etaSteps: rawStepsDone });
        etaMs = Math.round(newEnd - now);
      }
    }
  }

  return {
    percent: Math.max(PROGRESS_MIN_PERCENT, Math.min(PROGRESS_MAX_PERCENT, Math.round(percentRatio * 100))),
    etaMs,
  };
}

// --- Render: MINIMAL ---
// 🔧 exec │ 00:15
// ✅ done │ 00:31
function renderMinimal(session: SessionRuntime, _prefs: ConversationPrefs): string {
  const icon = resolveStatusIcon(session);
  const focus = resolveFocusLabel(session);
  if (session.phase === "idle") return `${icon} idle`;
  if (session.phase === "queued") return `${icon} ${focus}`;
  return `${icon} ${focus} │ ${formatClockMs(getElapsedMs(session))}`;
}

// --- Render: NORMAL ---
// 🔧 exec │ █████░░░░░ 52% │ ⏱00:15
// ✅ done │ ██████████ │ ⏱00:31
// ⏳ in coda │ ░░░░░░░░░░
function renderNormal(session: SessionRuntime, prefs: ConversationPrefs): string {
  const icon = resolveStatusIcon(session);
  const focus = resolveFocusLabel(session);
  const elapsed = formatClockMs(getElapsedMs(session));

  if (session.phase === "idle") return `${icon}idle`;
  if (session.phase === "queued") return `${icon} ${focus} │ ${BAR_EMPTY.repeat(BAR_WIDTH)}`;

  const progress = resolveProgress(session, prefs);
  const bar = renderProgressBar(progress.percent);

  if (session.phase === "done" || session.phase === "error" || session.phase === "sending") {
    return `${icon} ${focus} │ ${bar} │ ⏱${elapsed}`;
  }

  const pct = progress.percent != null ? ` ${progress.percent}%` : "";
  const parts = [`${icon} ${focus} │ ${bar}${pct} │ ⏱${elapsed}`];
  if (progress.etaMs != null) parts[0] += ` →${formatCompactSeconds(progress.etaMs)}`;
  return parts[0];
}

// --- Render: DETAILED ---
// 🔧 exec │ ⚙️opus │ █████░░░░░ 52% │ ⏱00:15 →13s │ 🧠1.2k↑340↓
// ✅ done │ ⚙️opus │ ██████████ │ ⏱00:31 │ 🧠1.5k↑890↓
// ⏳ in coda │ ░░░░░░░░░░ │ attendo...
function renderDetailed(session: SessionRuntime, prefs: ConversationPrefs): string {
  const icon = resolveStatusIcon(session);
  const focus = resolveFocusLabel(session);
  const elapsed = formatClockMs(getElapsedMs(session));
  const isActive = session.phase === "running" || session.phase === "tool";
  const model = shortModel(session.model, isActive || session.phase === "done" || session.phase === "error");
  const thinkRaw = session.thinkingLevel ?? DEFAULT_THINKING;
  const thinkLabel = thinkRaw.charAt(0).toUpperCase() + thinkRaw.slice(1);
  const modelTag = model ? ` ${model}|${thinkLabel}` : "";
  const tokens = formatTokens(session.usageInput, session.usageOutput);
  const tokTag = tokens ? ` │ ${tokens}` : "";

  if (session.phase === "idle") return `${icon}idle`;
  if (session.phase === "queued") return `${icon} ${focus} ${BAR_EMPTY.repeat(BAR_WIDTH)}`;

  const progress = resolveProgress(session, prefs);
  const bar = renderProgressBar(progress.percent);

  if (session.phase === "done" || session.phase === "error") {
    return `${icon} ${focus} │${modelTag} │ ${elapsed}${tokTag}`;
  }

  const pct = progress.percent != null ? `${progress.percent}%` : "";
  let line = `${icon} ${focus} │ ${bar} ${pct} │ ${elapsed}`;
  if (progress.etaMs != null) line += `→${formatCompactSeconds(progress.etaMs)}`;
  // v2.0: show tool counter when we have real predicted count from llm_output
  const done = session.currentRunSteps;
  const predicted = session.predictedSteps ?? 0;
  if (predicted > 0 && (session.phase === "tool" || session.phase === "running")) {
    line += ` │ ${done}/${predicted}▸`;
  } else if (done > 0 && session.phase === "tool") {
    line += ` │ ${done}▸`;
  }
  return line;

}

// --- Inline Buttons ---

type InlineButton = { text: string; callback_data: string };

const MODE_CYCLE: Record<string, string> = {
  minimal: "normal",
  normal: "detailed",
  detailed: "minimal",
};

function renderActiveButtons(prefs: ConversationPrefs): InlineButton[][] {
  const nextMode = MODE_CYCLE[prefs.mode] ?? "normal";
  return [[
    { text: `📊 ${nextMode}`, callback_data: `/sbmode ${nextMode}` },
    { text: prefs.pinMode ? "📌 Unpin" : "📌 Pin", callback_data: prefs.pinMode ? "/sbunpin" : "/sbpin" },
    { text: "⏹ Off", callback_data: "/sboff" },
  ]];
}

function renderDoneButtons(prefs: ConversationPrefs): InlineButton[][] {
  const nextMode = MODE_CYCLE[prefs.mode] ?? "normal";
  return [[
    { text: `📊 ${nextMode}`, callback_data: `/sbmode ${nextMode}` },
    { text: "🔄 Reset", callback_data: "/sbreset" },
    { text: "⏹ Off", callback_data: "/sboff" },
  ]];
}

export function renderStatusButtons(session: SessionRuntime, prefs: ConversationPrefs): InlineButton[][] | undefined {
  if (!prefs.buttonsEnabled) return undefined;
  if (session.phase === "queued" || session.phase === "running" || session.phase === "thinking" || session.phase === "tool" || session.phase === "sending") {
    return renderActiveButtons(prefs);
  }
  if (session.phase === "done" || session.phase === "error") {
    return renderDoneButtons(prefs);
  }
  return undefined;
}

// --- Public API ---

export function renderStatusText(session: SessionRuntime, prefs: ConversationPrefs): string {
  let text: string;
  switch (prefs.mode) {
    case "minimal":  text = renderMinimal(session, prefs); break;
    case "normal":   text = renderNormal(session, prefs); break;
    case "detailed": text = renderDetailed(session, prefs); break;
    default:         text = renderNormal(session, prefs);
  }
  return text;
}
