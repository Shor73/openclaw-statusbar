# openclaw-statusbar

OpenClaw plugin that shows a live status line in Telegram while the agent is running.

## Features (v0.1)

- Quick commands:
  - `/sbon` enables the status line in the current chat
  - `/sboff` disables the status line in the current chat
  - `/sbmode minimal|normal|detailed` changes the detail level
- Hooks used:
  - `message_received`
  - `before_agent_start`
  - `before_tool_call`
  - `after_tool_call`
  - `llm_output`
  - `agent_end`
- In-place Telegram updates via `editMessageText`
- Robust Telegram error handling:
  - 429 with `retry_after` + jitter
  - `message to edit not found` with message recreation

## Local install (dev)

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

Restart the gateway after changing config.

## Config

`plugins.entries.statusbar.config`

- `enabledByDefault` (boolean, default `false`)
- `defaultMode` (`minimal|normal|detailed`, default `normal`)
- `throttleMs` (default `1200`)
- `minThrottleMs` (default `900`)
- `maxRetries` (default `4`)
- `autoHideSeconds` (default `0`)
- `showInlineControls` (default `true`)
