import type { ConversationPrefs, SessionRuntime, TelegramInlineButtons } from "./types.js";

function formatElapsed(session: SessionRuntime): string {
  const end = session.endedAtMs ?? Date.now();
  const elapsedMs = Math.max(0, end - session.startedAtMs);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function resolveStatusLabel(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":
      return "QUEUED";
    case "running":
      return "RUNNING";
    case "tool":
      return "TOOL";
    case "done":
      return "DONE";
    case "error":
      return "ERROR";
    default:
      return "IDLE";
  }
}

function resolveStatusIcon(session: SessionRuntime): string {
  switch (session.phase) {
    case "queued":
      return "⏳";
    case "running":
      return "⚡";
    case "tool":
      return "🛠️";
    case "done":
      return "✅";
    case "error":
      return "❌";
    default:
      return "💤";
  }
}

export function renderStatusText(session: SessionRuntime, prefs: ConversationPrefs): string {
  const lines: string[] = [];
  const statusLabel = resolveStatusLabel(session);
  const statusIcon = resolveStatusIcon(session);
  const taskLabel = session.runNumber > 0 ? `#${session.runNumber}` : "#-";
  const pinMarker = prefs.pinMode ? " 📌" : "";
  lines.push(`${statusIcon} ${statusLabel} • Task ${taskLabel}${pinMarker}`);

  if (prefs.mode !== "minimal") {
    lines.push(`⏱️ ${formatElapsed(session)}`);
  }

  if (prefs.mode === "normal") {
    if (session.toolName) {
      lines.push(`🧰 ${session.toolName}`);
    }
    if (session.provider && session.model) {
      lines.push(`🤖 ${session.provider}/${session.model}`);
    }
    if (session.queuedCount > 0) {
      lines.push(`📬 Queue: ${session.queuedCount}`);
    }
  }

  if (prefs.mode === "detailed") {
    if (session.provider && session.model) {
      lines.push(`🤖 Model: ${session.provider}/${session.model}`);
    }
    if (session.toolName) {
      lines.push(`🧰 Tool: ${session.toolName}`);
    }
    lines.push(`📬 Queue: ${session.queuedCount}`);
  }

  if (prefs.mode === "detailed" && (session.usageInput != null || session.usageOutput != null)) {
    const inTokens = session.usageInput ?? 0;
    const outTokens = session.usageOutput ?? 0;
    lines.push(`🔢 Tokens: in ${inTokens} / out ${outTokens}`);
  }

  if (session.phase === "error" && session.error) {
    lines.push(`⚠️ Error: ${session.error}`);
  }

  return lines.join("\n");
}

export function buildEnabledControls(prefs: ConversationPrefs): TelegramInlineButtons {
  return [
    [
      { text: "Off", callback_data: "/sboff" },
      { text: `Mode: ${prefs.mode}`, callback_data: "/sbmode" },
    ],
    [
      { text: "Minimal", callback_data: "/sbmode minimal" },
      { text: "Normal", callback_data: "/sbmode normal" },
      { text: "Detailed", callback_data: "/sbmode detailed" },
    ],
  ];
}

export function buildDisabledControls(): TelegramInlineButtons {
  return [[{ text: "Enable", callback_data: "/sbon" }]];
}
