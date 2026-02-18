# openclaw-statusbar

Plugin OpenClaw per mostrare una statusline live in Telegram durante l'esecuzione dell'agente.

## Funzioni (v0.1)

- Comandi rapidi:
  - `/sbon` abilita la statusline nella chat corrente
  - `/sboff` disabilita la statusline nella chat corrente
  - `/sbmode minimal|normal|detailed` cambia il livello di dettaglio
- Hook usati:
  - `message_received`
  - `before_agent_start`
  - `before_tool_call`
  - `after_tool_call`
  - `llm_output`
  - `agent_end`
- Update Telegram in-place con `editMessageText`
- Gestione robusta errori Telegram:
  - 429 con `retry_after` + jitter
  - `message to edit not found` con ricreazione del messaggio

## Installazione locale (dev)

Aggiungi il path alla config OpenClaw:

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

Riavvia il gateway dopo la modifica.

## Config

`plugins.entries.statusbar.config`

- `enabledByDefault` (boolean, default `false`)
- `defaultMode` (`minimal|normal|detailed`, default `normal`)
- `throttleMs` (default `1200`)
- `minThrottleMs` (default `900`)
- `maxRetries` (default `4`)
- `autoHideSeconds` (default `0`)
- `showInlineControls` (default `true`)
