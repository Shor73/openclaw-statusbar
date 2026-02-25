# Changelog

## [1.1.0] — 2026-02-25

### ✨ Inline buttons

Interactive buttons below the status bar — no need to type commands:

- **During execution:** `[ 📊 mode ] [ 📌 Pin/Unpin ] [ ⏹ Off ]`
- **On completion:** `[ 📊 mode ] [ 🔄 Reset ] [ ⏹ Off ]`
- Mode button cycles: minimal → normal → detailed → minimal
- Toggle with `/sbbuttons` (on/off per chat)
- Buttons leverage Telegram's native callback_query — processed as commands by OpenClaw

---

## [1.0.0] — 2026-02-25

**First stable release.** 🎉

### ✨ Per-tool icons

Every tool now has a unique emoji — you always know what the agent is doing at a glance:

🖥 exec · 📖 Read · ✏️ Write · 🔏 Edit · ⏱️ process · 🔍 web_search · 🌐 web_fetch/browser · 💬 message · 🔌 gateway · 🎨 canvas · 🔗 nodes · ⏰ cron · 🧬 sessions_spawn · 📤 sessions_send · 🤖 subagents · 📋 session_status · 🖼 image · 🧠 memory_search/memory_get · 🔊 tts

Phase icons: 🔜 queued · 💭 thinking · 🟢 done · ❌ error

### ✨ Adaptive ETA (v3 — predicted end time)

- Calculates predicted end timestamp from step rate
- Smooth countdown between tool calls
- Auto-bumps forward when estimate is exceeded (ETA never shows 0 during active runs)
- Gets more accurate over time with historical data

### ✨ Three display modes

- **minimal** — `💭 thinking │ 00:15`
- **normal** — `🖥 exec │ ████░░░ 52% │ 00:15→13s`
- **detailed** *(default)* — full info with model, thinking level, tokens

### ✨ Mobile-optimized layout

- Progress bar 7 chars (fits Telegram pin bar)
- Compact token display: `1.5k↑340↓`
- Model + thinking inline: `opus-4.6|High`

### 🔴 Fixes since 0.2.0

- **#22** — renderTimer not cancelled on urgent flush
- **#23** — accountId mismatch between hooks (queued vs running)

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
