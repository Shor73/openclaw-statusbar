# Changelog

## [3.0.5] — 2026-03-08

### 🔴 Complete rewrite — shared filesystem state

**Root cause fix:** The plugin loaded as 2 separate instances (`[gateway]` and `[plugins]`) with independent in-memory Maps. 59 patches tried to coordinate them via lock files. This release replaces all of that with a single shared state file.

**Second root cause:** Session key `agent:main:telegram:direct:25017841` was parsed as "legacy format" → `accountId="default"` instead of `"main"` → statusbar was disabled for all hooks except `message_received`.

### Architecture

- **Shared state:** `/tmp/statusbar-runs.json` — single source of truth for run lifecycle, readable by both instances
- **writerInstanceId:** PID-based (not random) — both instances share the same PID, treated as same writer
- **canRender():** only the writer instance renders; stale writer (>5s) allows takeover
- **accountId fix:** `resolveTargetForSession` extracts agentId from session key when parser returns "default"

### Removed (from v2.x)

- All lock files (`/tmp/statusbar-lock-*`)
- `wasLockOwner`, `isLockOwner`, `isLocked`, `acquireLock`, `releaseLock`, `touchLock`, `clearStaleLocks`
- `llmDoneTimer` (5s fallback from fix #56)
- `pendingDelivery` / `pendingDeliveryTimer` (fix #37/#39)
- Cross-instance detection (fix #54/#55/#58/#59)
- Dual-instance session creation (fix #52)

### Kept

- All `src/` modules unchanged (store, transport, render, resolver, types, config)
- `maxRunTimer` (90s safety net)
- Auto-hide, progress estimation, ETA, inline buttons
- All `/sb*` commands
- Conversation stats (historyRuns, avgSteps, toolAvgDurations)
- "sending" → "done" transition via `message_sent` hook (max 500ms visible)

### Stats

- **1557 → 1140 lines** (-27%)
- **0 TypeScript errors**
- **59 fix workarounds → 0**

---

## [2.5.1] — 2026-03-08

### Fixes #50-59

- Cross-instance done detection via lock files
- `wasLockOwner` flag for flush guards
- `llm_output`-based done detection
- Anti-flickering: only lock owner flushes

## [2.4.0] — 2026-03-08

### ✨ New (v2026.3.7 compatibility)

- **Fix #32** — `before_compaction` / `after_compaction` hooks
- **Fix #33** — `before_prompt_build` hook for command injection
- **Fix #35** — `openclaw.plugin.json` explicit hooks declaration
- **Fix #36** — v2026.3.7 session key format for forum groups

## [2.1.4] — 2026-03-03

### 🔴 Critical fix

- **#29 — Cross-instance lock** — first attempt at solving the dual-instance problem

## [2.1.0] — 2026-03-03

### ✨ Reactive N/M▸ tool counter

- Predict total steps from `llm_output` tool_use blocks
- Per-tool duration tracking for ETA estimation

## [2.0.0] — 2026-03-02

### ✨ Major features

- Predictive progress bar with ETA
- Inline control buttons (mode switch, pin, off)
- Tool duration tracking (EMA)
- "sending" phase before "done"
- Thinking level display

## [1.0.0] — 2026-02-24

### 🎉 Initial release

- Live Telegram statusbar for OpenClaw agent runs
- Three modes: minimal, normal, detailed
- Pin support, auto-hide, rate limit protection
