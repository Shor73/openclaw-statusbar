# Changelog

## [0.4.0] — 2026-02-25

### ✨ New: Geek Edition render

Complete rewrite of the render layer. Three distinct display modes:

- **minimal** — `⚡ thinking │ 00:15` — phase + elapsed only
- **normal** — `🔧exec │ ████░░░ 52% │ 00:15→13s` — adds progress bar + ETA
- **detailed** *(default)* — full info including model, thinking level, tokens

Switch anytime with `/sbmode minimal|normal|detailed`.

### ✨ New: Mobile-optimized layout

- Progress bar width reduced to 7 chars (fits Telegram pin bar on mobile)
- No space between icon and tool name during active phases
- Model label with version: `opus-4.6`, `sonnet-4.6`, `haiku-4.5`
- Thinking level inline: `opus-4.6|High`
- Token display without icon: `1.5k↑340↓`
- 🟢 as done icon, `s` suffix on final time

### ✨ New: Predictive progress with historical data

- Tracks `avgDurationMs`, `avgSteps`, `historyRuns` across sessions
- ETA estimated from run history — gets tighter after 10+ runs
- State persisted to `~/.openclaw/plugins/openclaw-statusbar/state.json`

### 🔴 Fix #22 — renderTimer not cancelled on urgent flush

When an urgent `markDirty` fired while a `renderTimer` was pending, the timer would still fire and overwrite the urgent render with stale data. Fixed by cancelling pending `renderTimer` before scheduling urgent flushes.

### 🔴 Fix #23 — accountId mismatch between hooks

`onMessageReceived` resolved `accountId="main"` while `onBeforeAgentStart` resolved `accountId="default"`, causing the plugin to create two separate sessions for the same chat. Fixed by reusing the `accountId` of any already-tracked session for the same `chatId/threadId` in `resolveTargetForSession`.

---

## [0.2.0] — 2026-02-19

### 🔴 Critical fixes

- **#1 — Memory leak `sessions` Map**
  Sessions removed after 2h inactivity via `cleanupSessions()`.

- **#2 — No plugin teardown**
  Added `destroy()` method — stops `liveTicker`, cancels all timers, clears session map. Supports hot-reload.

- **#3 — Race condition on `persist()`**
  Writes serialized via promise chain (`persistQueue`). No more concurrent file corruption.

- **#4 — No `fetch()` timeout**
  Every Telegram API call uses `AbortController` with configurable timeout (10s edit, 15s send/pin).

- **#5 — `editStatusMessage` swallowed real error codes**
  Original error code now preserved. 429s from SDK path correctly detected by circuit breaker. Textual heuristic fallback for unstructured errors.

- **#17 — No global circuit breaker**
  Added `GlobalRateLimiter` in transport. When a 429 is received, all requests to `(accountId, chatId)` are blocked for `retry_after` duration.

- **#18 — Default throttle too aggressive (caused 429 bans)**
  | Param | Before | After |
  |---|---|---|
  | `throttleMs` | 1200ms | 4000ms |
  | `minThrottleMs` | 900ms | 2500ms |
  | `liveTickMs` | 1000ms | 2500ms |

- **#19 — No fetch timeout guard in circuit breaker check**
  `flushSession` now checks circuit breaker before every API call.

- **#20 — Phase transition didn't bypass throttle**
  Phase changes now trigger urgent flush (bypass throttle) for immediate UI feedback.

- **#21 — `sendMessage` had 0 retries same as ephemeral edits**
  `maxRetriesSend` defaults to 4. Critical operations (send/pin) retry; edits don't.
