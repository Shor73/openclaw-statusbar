# openclaw-statusbar

Live Telegram status line plugin for OpenClaw.

[![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-111111)](https://github.com/openclaw/openclaw)
[![Telegram](https://img.shields.io/badge/Channel-Telegram-26A5E4)](https://telegram.org/)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178C6)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

`openclaw-statusbar` shows a single in-place status message in Telegram while an OpenClaw run is active, including queue/running/tool/done/error phases, model info, elapsed time, and optional token usage.

## Preview

### Minimal mode

```text
Status: RUNNING
Tool: browser.search
```

### Normal mode

```text
Status: TOOL
Model: openai/gpt-5
Elapsed: 18s
Tool: browser.fetch
```

### Detailed mode

```text
Status: DONE
Model: openai/gpt-5
Elapsed: 42s
Tokens: in 1281 / out 764
```

## Why this plugin

- Keeps chat clean: one status message is edited instead of sending many updates
- Telegram-first UX for bot-based workflows
- Per-chat preferences (enabled/mode) persisted across restarts
- Works with DM, groups, and forum topics

## Features

- Commands:
  - `/sbon` enable status line in current Telegram chat
  - `/sboff` disable status line in current Telegram chat
  - `/sbmode minimal|normal|detailed` set rendering mode
- Hooks used:
  - `message_received`
  - `before_agent_start`
  - `before_tool_call`
  - `after_tool_call`
  - `llm_output`
  - `agent_end`
- Reliable transport:
  - 429 handling with `retry_after` + jitter
  - dedupe/throttle to reduce Telegram edits
  - auto-recreate status message on `message to edit not found`

## Install (local development)

Add the plugin path to your OpenClaw config:

```json5
{
  plugins: {
    load: {
      paths: ["/home/angelo/openclaw-statusbar"]
    },
    entries: {
      statusbar: {
        enabled: true,
        config: {
          enabledByDefault: false,
          defaultMode: "normal"
        }
      }
    }
  }
}
```

Restart the OpenClaw gateway after config changes.

## Configuration

Path: `plugins.entries.statusbar.config`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabledByDefault` | `boolean` | `false` | Default enable state for new chats |
| `defaultMode` | `minimal \| normal \| detailed` | `normal` | Default render mode |
| `throttleMs` | `number` | `1200` | Base edit throttle |
| `minThrottleMs` | `number` | `900` | Minimum throttle floor |
| `maxRetries` | `number` | `4` | Max retries for transient Telegram/API failures |
| `autoHideSeconds` | `number` | `0` | Auto-hide after completion (`0` disables) |
| `showInlineControls` | `boolean` | `true` | Show inline command controls in Telegram |

## How it works

1. `message_received` resolves Telegram target (`conversationId`, `threadId`, `accountId`) and enters queued state.
2. `before_agent_start` sets running state.
3. `before_tool_call` and `after_tool_call` switch tool/running phases.
4. `llm_output` captures `provider/model` and usage (`usage.input`, `usage.output`).
5. `agent_end` marks done/error and optionally auto-hides.

The status message reference (`messageId`) is stored per conversation/thread. If a user deletes it manually, the plugin clears the stale id and sends a new status message.

## Development

```bash
npm install
npm run typecheck
```

## Status

Current phase: `v0.1` (core plugin + robust Telegram transport).

Planned next steps:

- richer inline controls
- optional cost estimation
- release packaging for npm distribution

## License

MIT
