# Changelog

## [0.2.0] — 2026-02-19

### 🔴 Critical fixes

- **#1 — Memory leak `sessions` Map** (`index.ts`)
  Sessions completate vengono ora rimosse dopo 2h di inattività tramite `cleanupSessions()` chiamata ad ogni tick.

- **#2 — Nessun teardown del plugin** (`index.ts`)
  Aggiunto metodo `destroy()` che ferma `liveTicker`, cancella tutti i `setTimeout`/`setInterval` attivi e svuota la `sessions` Map. Restituito da `register()` per supportare hot-reload di OpenClaw.

- **#3 — Race condition su `persist()`** (`src/store.ts`)
  Le scritture su disco sono ora serializzate tramite una promise chain (`persistQueue`). Due chiamate concorrenti non possono più corrompere il file di stato.

- **#4 — Nessun timeout su `fetch()`** (`src/transport.ts`)
  Ogni chiamata a `api.telegram.org` usa ora un `AbortController` con timeout configurabile (10s per edit, 15s per send/pin). Previene hang indefiniti su reti lente.

- **#5 — `editStatusMessage` riclassificava tutti gli errori come `code: 400`** (`src/transport.ts`)
  Il codice originale dell'errore viene ora preservato. I 429 ricevuti via path SDK vengono correttamente riconosciuti e gestiti dal circuit breaker. Heuristic testuale come fallback (`/429|too many requests|rate.?limit/i`) per errori senza codice.

- **#17 — Nessun circuit breaker globale per bot+chat** (`src/transport.ts`, `index.ts`)
  Aggiunta classe `GlobalRateLimiter` interna al transport. Quando un 429 viene ricevuto (da qualsiasi path — SDK o diretto), tutte le richieste verso quel `(accountId, chatId)` vengono bloccate per la durata del `retry_after`. `flushSession` controlla il circuit breaker prima di ogni chiamata API.

- **#18 — Default throttle troppo aggressivi (causa del ban 429)** (`openclaw.plugin.json`, `src/config.ts`)
  | Parametro | Prima | Dopo |
  |---|---|---|
  | `throttleMs` | 1200ms | 4000ms |
  | `minThrottleMs` | 900ms | 2500ms |
  | `liveTickMs` | 1000ms | 2500ms |

  Il throughput massimo teorico passa da ~50 edit/min a ~15 edit/min per sessione, ben sotto il limite Telegram (~20–30/min).

- **#19 — `callTelegram` ritentava i 429 sugli edit** (`src/transport.ts`)
  Gli edit della statusbar sono efimeri: se manca un update, il prossimo tick lo recupera. Ritentare un 429 su `editMessageText` aggravava il ban. Ora `maxRetriesEdit` è 0 per default: il 429 viene propagato immediatamente, il circuit breaker si aggiorna, e il prossimo liveTick riprova.

### 🟠 Important fixes

- **#6 — Regex ricreate a ogni chiamata** (`src/resolver.ts`, `index.ts`)
  `RE_TOPIC_SUFFIX`, `RE_THREAD_SUFFIX`, `RE_HAS_TOPIC_OR_THREAD`, `RE_COMMAND`, `RE_AGENT_ID`, `RE_AGENT_MAIN` sono ora costanti di modulo.

- **#7 — `pruneSessionTargets` eseguita ridondantemente** (`index.ts`)
  Rimosso il prune da `trackSessionTarget` e `trackSenderTarget`. Aggiunto `maybePruneSessionTargets()` con debounce da 5 minuti, chiamato in `onLiveTick`.

- **#8 — `getConversation` mutava il record in-place** (`src/store.ts`)
  Estratta funzione pura `migrateConversationPrefs()` che restituisce sempre un nuovo oggetto. Stile ora consistente con il resto dello store.

- **#9 — Collisione possibile in `resolveRuntimeSessionKey`** (`index.ts`)
  Il separatore `:` causava ambiguità con `conversationId` che contiene già `:` (es. `telegram:123456`). Sostituito con `|`.

- **#10 — Silent catch su corruzione store** (`src/store.ts`)
  `readStoreFile` ora distingue `ENOENT` (normale, silenzioso) da errori JSON/IO (loggati via il logger opzionale passato dal costruttore).

- **#20 — `maxRetries` uniforme per tutte le operazioni** (`src/types.ts`, `src/config.ts`, `src/transport.ts`, `openclaw.plugin.json`)
  Rimosso `maxRetries`. Aggiunto:
  - `maxRetriesEdit` (default `0`) — edit efimeri, nessun retry
  - `maxRetriesSend` (default `4`) — send/pin critici, ritenta

### 🟡 Refactoring / cleanup

- **#11 — Dead code rimosso** (`src/render.ts`)
  Eliminate `buildEnabledControls()` e `buildDisabledControls()` che ritornavano sempre `[]` e non erano usate.

- **#12 — Magic numbers → costanti nominate** (`src/render.ts`)
  `PROGRESS_STEP_WEIGHT`, `PROGRESS_TIME_WEIGHT`, `PROGRESS_MIN_RATIO`, `PROGRESS_MAX_RATIO`, `PROGRESS_MIN_PERCENT`, `PROGRESS_MAX_PERCENT`, `ETA_MIN_RATIO_THRESHOLD`, `FALLBACK_STEPS_TOTAL`.

- **#13 — `split()[0] ??` dead code** (`src/resolver.ts`)
  `String.prototype.split()` restituisce sempre almeno un elemento. Sostituiti tutti i pattern `split(...)[0] ?? fallback` con `split(...)[0]!`.

- **#14 — `onLiveTick` senza early-exit ottimale** (`index.ts`)
  I check sono ora ordinati dal meno (fase, throttle locale) al più costoso (lookup store). Aggiunto `Set<RunPhase>` costante `ACTIVE_PHASES` per il confronto O(1).

- **#15 — Nessuna migrazione store** (`src/store.ts`)
  `load()` ora verifica `version`. Se il valore è diverso da `1`, logga un warning e resetta lo stato. Punto di migrazione predisposto per versioni future.

- **#16 — Stile inconsistente negli handler** (`index.ts`)
  Tutti gli handler multi-riga usano ora lo stesso stile array + `.join("\n")`. `/sbsettings` ora mostra `maxRetriesEdit` e `maxRetriesSend`.

- **#21 — Flush urgente per cambi di fase (fluidità)** (`index.ts`)
  `markDirty(session, urgent=true)` azzera `nextAllowedAtMs` per bypassare il throttle. Usato su `before_agent_start`, `before_tool_call`, `after_tool_call`, `agent_end`. Il ticker periodico usa `markDirty(session)` (urgent=false) e rispetta il throttle. Aggiunto throttle adattivo per fase: `TOOL` = 2000ms, `RUNNING` = throttleMs, `QUEUED` = throttleMs×2.

### Migration notes

- `maxRetries` è stato rimosso dalla config. Se presente in `openclaw.json`, verrà ignorato silenziosamente (la validazione dello schema scarta le chiavi sconosciute). Aggiungere manualmente `maxRetriesEdit` e `maxRetriesSend` se si vuole sovrascrivere i nuovi default.
- Il formato della session key in memoria è cambiato (separatore `|` invece di `:`). Non ha impatto perché le session key sono solo in-memory e vengono rigenerate al riavvio.
