# codex-orchestrator

MCP-Server, der **Claude** (Orchestrator/Reviewer) und **Codex** (Executor)
nach dem *Checkpoint-Slice*-Modell koppelt. Umsetzung von
`orchestrator-plan-v2.md` (M0–M3). Claude plant, entscheidet, prüft und gibt
frei; Codex implementiert in begrenzten Slices; der Server erzwingt die
Cluster-Zustandsmaschine, persistiert allen Prozesszustand in SQLite und hält
harte Sicherheits-/Laufzeitlimits.

## Status
- **M0** Ein-Slice-Task, JSONL-Parsing, `task_result` — ✅ end-to-end verifiziert
- **M1** SQLite-Store, Slice-Loop mit Resume, `task_wait`/`task_events`,
  `task_control` (pause/resume/cancel/inject), Watchdog/Reaper, Limits — ✅
- **M2** `cluster_plan`, `cluster_transition` (servererzwungen), `hypotheses`,
  `repo_check` (Allowlist), Review/Retro-Persistenz — ✅
- **M3** Worktree-Isolation, paralleler Start, `cluster_merge` — ✅
- **M4** (app-server-Interaktivität, compare_model_outputs, Telemetrie) — bewusst
  ausgelassen (optional laut Plan)

## Architektur
```
Claude (Claude Code, CLAUDE.md = Orchestrator-Prompt)
  │  10 Tools + cluster_merge (M3)
codex-orchestrator (dieser MCP-Server, TypeScript/Node)
  ├─ Session Manager   src/session.ts   (Slice-Loop, Resume, Steuerung, Limits, Reaper)
  ├─ State Store       src/db.ts        (node:sqlite; Plans/Cluster/Tasks/Events/…)
  ├─ Codex-Wrapper     src/codex.ts     (codex exec/resume, JSONL, Budget-Kill)
  ├─ Zustandsmaschine  src/statemachine.ts (Gates, confirm-Bedingung, Retro-Pflicht)
  ├─ Check Runner      src/checks.ts    (allowlisted argv, Diff-Größe)
  └─ Worktree Manager  src/worktree.ts  (git worktrees, Merge)
Codex CLI  →  codex exec --json --ignore-user-config -c sandbox_mode=… -c model=… -c model_reasoning_effort=…
```

## Voraussetzungen
- Node ≥ 22.5 (nutzt eingebautes `node:sqlite`; hier getestet mit v25).
- `codex` CLI installiert **und angemeldet** (`codex login status` → *logged in*).
- Für Worktree/Merge: Ziel-Repos sind git-Repos.

## Build & Test
```bash
npm install
npm run build          # tsc -> dist/
npm test               # Unit-Tests (Parser + Zustandsmaschine), ohne API
node scripts/modelcheck.mjs   # Modell/Effort-Validierung, ohne API
node scripts/e2e-mcp.mjs      # E2E M0/M2 mit echtem Codex (kostet API)
node scripts/e2e-m1m3.mjs     # E2E M1/M3 mit echtem Codex (kostet API)
```

## Registrierung in Claude Code
```bash
claude mcp add codex-orchestrator -- node /Users/tomwerner/codex-orchestrator/dist/server.js
```
oder in der MCP-Konfiguration:
```json
{
  "mcpServers": {
    "codex-orchestrator": {
      "command": "node",
      "args": ["/Users/tomwerner/codex-orchestrator/dist/server.js"],
      "env": { "ORCH_HOME": "/Users/tomwerner/.codex-orchestrator" }
    }
  }
}
```
Den Inhalt von `CLAUDE.md` als Orchestrator-Prompt ins Orchestrierungs-Repo
übernehmen (oder in die Projekt-`CLAUDE.md` einbetten).

## Tools (Claude-facing API)
`task_start`, `task_wait`, `task_events`, `task_control`, `task_result`,
`models_list`, `cluster_plan`, `cluster_transition`, `hypotheses`, `repo_check`
(= 10 Kern-Tools laut Plan §7) plus `cluster_merge` (M3-Ergänzung für den
Worktree-Merge-Schritt).

### Modell- & Effort-Wahl pro Task
`models_list` liefert die real verfügbaren Modelle (`gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`) samt zulässiger Effort-Stufen. `task_start` erwartet **model**
(konkreter Name oder `auto`) **und** **effort** (`low|medium|high|xhigh`).
Ungültige Kombinationen (z. B. `gpt-5.4-mini` + `xhigh`) werden abgelehnt, bevor
Codex überhaupt gestartet wird. Modellnamen sind konfigurierbar via
`ORCH_MODEL_FAST|BALANCED|STRONG`.

## Sicherheit & Limits (fail-closed, Plan §11)
- `danger-full-access` ist deaktiviert und **nicht** per Tool-Parameter erreichbar.
- Codex-Runs laufen mit `--ignore-user-config` (isoliert von globalen Plugins/
  Personality); Auth kommt weiter aus `CODEX_HOME`.
- Netzwerk für Slices default **aus** (`sandbox_workspace_write.network_access=false`).
- `repo_check` führt nur **allowlisted** argv-Kommandos aus (keine freie Shell).
- Limits pro Task: max. Slices, max. Gesamtlaufzeit, max. Diff (Zeilen/Dateien) →
  Überschreitung setzt Status `blocked`.
- Reaper: verwaiste `running`-Tasks werden bei Server-Restart auf `failed`
  gesetzt; Wiederaufnahme ist ein bewusster `task_control(resume)`-Schritt.

### Hinweis zu git-Commit-Signing
Dieses System committet selbst nur beim Merge (`cluster_merge`). Ist global
`commit.gpgsign=true` mit SSH-Key gesetzt, muss der Signing-Key im `ssh-agent`
entsperrt sein, sonst schlägt der Merge-Commit nicht-interaktiv fehl. Alternativ
`ORCH_SIGN_MERGE=false` (oder `cluster_merge(sign:false)`) für unsignierte
Merge-Commits. Default: signieren (Policy bleibt erhalten).

### Härtung (aus Selbst-Review)
- **`extra_config` fail-closed:** ganze Kategorien gesperrt (`mcp_servers`, `hooks`,
  `shell_environment_policy`, `sandbox*`, `danger*`, `approval_policy`, `trust`,
  `features`, `projects`) — verhindert Prozess-/MCP-/Umgebungs-Injektion in Codex.
- **Budget-Kill = Entscheidungspunkt:** ein wegen Zeitbudget abgeschossener Slice
  wird `blocked` statt blind resumt — kein Endlos-Resume auf inkonsistenter Session.
- **Injection-Zustellung nur bei sauberem Abschluss:** bei killed/failed bleibt die
  Injection pending und wird im nächsten Resume erneut geliefert (kein Verlust).
- **Reaper terminiert verwaiste Codex-OS-Prozesse** (nicht nur DB-Status).
- **Graceful Shutdown:** SIGINT/SIGTERM terminiert laufende Codex-Kinder, räumt
  `instance.json` auf.
- **Live-Fortschritt:** Kommando-Events werden mid-slice persistiert → `task_wait`
  reagiert sofort, nicht erst am Slice-Ende.
- **Worktree-Cleanup:** `cluster_merge(cleanup:true)` entfernt Worktree + Branch nach
  erfolgreichem Merge; Worktree-Verzeichnis trägt die echte `task_id`.

## Projekt-Isolation (mehrere Projekte gleichzeitig)
Damit gleichzeitig bearbeitete Projekte sich **nie** vermischen oder überschreiben:

- **Store pro Projekt.** `ORCH_HOME` bestimmt DB + Worktrees. Default (ohne
  `ORCH_HOME`): `<cwd>/.orchestrator` — jedes Projekt-Arbeitsverzeichnis bekommt
  automatisch seinen eigenen Store. **Empfohlen:** den Server **projektbezogen**
  registrieren (`.mcp.json` im Projekt) mit eigenem `ORCH_HOME`. Ein globaler
  Store lässt sich mit `ORCH_GLOBAL=true` erzwingen (nicht empfohlen bei Parallelbetrieb).
- **Prozess-sicherer Reaper.** Tasks tragen die `owner_pid` der ausführenden
  Instanz. Beim Start werden **nur** Tasks toter Prozesse auf `failed` gesetzt;
  Tasks einer lebenden Nachbar-Instanz bleiben unangetastet → **kein Cross-Kill**
  zwischen gleichzeitig laufenden Projekten (auch bei geteiltem Store).
- **Instanz-Warnung.** Bedient bereits eine lebende Instanz denselben Store, warnt
  der Start deutlich (`instance.json`-Advisory).
- **Schreibkonflikte.** `PRAGMA busy_timeout=5000` fängt gleichzeitige Schreibzugriffe
  ab statt `SQLITE_BUSY` zu werfen.
- **Getrennte Stores mischen keine Daten** (per Konstruktion; unit-getestet).
- Codex-Threads sind ohnehin isoliert (eigene `thread_id`/Session je Task).

Beispiel projektbezogene Registrierung (im Projekt-Repo):
```json
{ "mcpServers": { "codex-orchestrator": {
  "command": "node",
  "args": ["/Users/tomwerner/codex-orchestrator/dist/server.js"],
  "env": { "ORCH_HOME": "${workspaceFolder}/.orchestrator" }
}}}
```

## Konfiguration (ENV)
| Variable | Default | Zweck |
|---|---|---|
| `ORCH_HOME` | `~/.codex-orchestrator` | Store + Worktrees |
| `ORCH_CODEX_BIN` | `codex` | Pfad zur Codex-CLI |
| `ORCH_MAX_CONCURRENT` | `2` | Max. parallele Slices |
| `ORCH_MODEL_FAST/BALANCED/STRONG` | gpt-5.4-mini/gpt-5.5/gpt-5.5 | Klassen-Defaults |
| `ORCH_SIGN_MERGE` | `true` | Merge-Commits signieren |
| `ORCH_GLOBAL` | `false` | `true` erzwingt globalen Store `~/.codex-orchestrator` |
| `ORCH_AUTO_UPDATE` | `true` | Codex-Auto-Update beim Serverstart |
| `ORCH_CODEX_CHANNEL` | `latest` | Update-Kanal: latest \| alpha \| beta |
