# Produktionsabschluss: Design

## Ziel

Version 1.4.0 schließt die verbliebenen Abnahmelücken des Claude-Plugins:
keine ungenutzte Selbstupdate-Implementierung, keine doppelte
Redaction-Logik, ein reproduzierbarer Effizienznachweis und ein automatisierter
End-to-End-Test über einen echten OpenSSH-Transport mit persistentem
`CODEX_HOME` über unabhängige Orchestrator-Instanzen.

## Ausgangslage

- `src/plugin.ts` und `tests/plugin.test.mjs` testen eine aus dem Server
  entfernte Selbstupdate-Funktion. Kein Produktionsmodul importiert sie.
- `src/redact.ts` und `src/runtime/redaction.ts` implementieren überlappende
  Secret-Muster getrennt.
- Remote-Tests verwenden bisher ein Fake-SSH-Programm. Sie decken das
  Worker-Protokoll ab, aber nicht `ssh`, `scp`, Host-Key-Prüfung und
  content-adressiertes Deployment zusammen.
- `remote.codexHome` wird beim Bootstrap verwendet, aber noch nicht konsistent
  an Remote-Doctor und Remote-Codex-Slices weitergegeben. Ein vom Standard
  abweichendes persistentes Remote-Home ist dadurch nicht vollständig belegt.
- Es existiert kein wiederholbarer Benchmark mit definierten Budgets.

## Gewählter Ansatz

### 1. Redundanzbereinigung

Die obsolete Selbstupdate-Implementierung und ihr isolierter Test werden
gelöscht. Claude Marketplace bleibt die einzige Plugin-Update-Autorität.

`src/redact.ts` wird zur kanonischen Redaction-Implementierung.
`src/runtime/redaction.ts` bleibt ausschließlich als kompatibler, logischer
Adapter bestehen und delegiert `redact` an `redactText`; dort befinden sich
keine eigenen Secret-Regeln mehr. Ein Strukturtest verhindert die Rückkehr der
gelöschten Selbstupdate-Datei und neuer paralleler Redaction-Muster.

### 2. Remote-Auth und Prozessneustart

`codexHome` wird als explizite Execution-Target-Eigenschaft durch alle
Schichten geführt:

1. validierte Projektkonfiguration,
2. `SshExecutionTarget`,
3. versioniertes Worker-Protokoll,
4. `LocalExecutionTarget` im Worker,
5. Doctor, Token-Login und Codex-Slice.

Die Prozessumgebung erhält `CODEX_HOME` ausschließlich für Codex-Prozesse.
Repository-Checks und Git erben es weiterhin nicht.

Der neue Abnahmetest startet auf einem zufälligen High-Port einen ephemeren
OpenSSH-Server mit temporären Host- und Nutzer-Keys. Er verwendet die echten
Systemprogramme `ssh`, `scp` und `sshd`, einen eigenen `known_hosts`-Eintrag,
ein separates Remote-Repository und ein separates Remote-`CODEX_HOME`.

Der synthetische Standardmodus prüft CI-fähig:

- Worker-Upload und Protokoll-Handshake,
- fehlende Remote-Authentifizierung vor dem Bootstrap,
- atomare Auth-Synchronisierung mit Modus `0600`,
- erfolgreichen Doctor,
- einen Remote-Codex-Slice,
- eine vollständig neue Target-Instanz nach simuliertem Neustart,
- erneute Authentifizierung ohne lokale Credential-Datei.

Ein expliziter `--real-auth`-Modus verwendet die vorhandene private lokale
Codex-`auth.json` und das reale Codex-Binary ausschließlich in temporären,
beim Beenden gelöschten Verzeichnissen. Er prüft Loginstatus und Persistenz,
führt aber keinen kostenpflichtigen Modellturn aus und gibt keine
Credential-Inhalte aus.

### 3. Effizienzbenchmark

Ein MCP-Benchmark startet das Release-Bundle wiederholt mit dem vorhandenen
Fake-Codex und misst:

- Bundle-Größen für Server und Worker,
- MCP-Kaltstart bis `listTools`,
- `orchestrator_doctor`-Latenz,
- Median und 95. Perzentil.

Feste, bewusst hardwaretolerante Budgets verhindern grobe Regressionen:

- Server-Bundle höchstens 1.25 MiB,
- Worker-Bundle höchstens 256 KiB,
- MCP-Kaltstart p95 höchstens 2.5 Sekunden,
- Doctor p95 höchstens 1.5 Sekunden.

Der Benchmark verwendet mindestens fünf Läufe und beendet sich bei
Budgetüberschreitung mit Exitcode 1. CI führt ihn nach reproduzierbarem Bundle-
Build aus.

## Fehler- und Sicherheitsverhalten

- Fehlt `sshd`, wird der synthetische Remote-Test mit einer eindeutigen
  Voraussetzungsmeldung beendet, nicht still übersprungen.
- Alle Test-Keys sind ephemer. Private Keys besitzen Modus `0600`; das
  temporäre Stammverzeichnis `0700`.
- Der reale Auth-Modus akzeptiert nur eine reguläre, inhaberkontrollierte
  Credential-Datei mit privaten Rechten. Inhalte erscheinen weder in stdout,
  stderr noch Ergebnisobjekten.
- `sshd`, Worker und MCP-Prozesse werden in `finally`-Blöcken beendet;
  temporäre Verzeichnisse werden rekursiv gelöscht.
- Fallback bleibt auf retrybare Konnektivitätsfehler begrenzt.

## Dokumentation und Release

- README erhält automatisierte Remote-Abnahme- und Benchmark-Befehle.
- Changelog dokumentiert 1.4.0 und die Entfernung des Legacy-Codes.
- Paket-, Lockfile-, Plugin- und Runtime-Version bleiben identisch.
- Nach grüner CI wird der PR nach `main` gemergt, Plugin 1.4.0 per Terminal
  deinstalliert und neu aus dem Marketplace installiert.

## Akzeptanzkriterien

1. Kein Produktionsimport und keine Datei für die entfernte Plugin-
   Selbstupdate-Logik verbleibt.
2. Es existiert genau eine Implementierung der Secret-Muster.
3. Alle bisherigen Tests bleiben grün.
4. Neue Tests belegen `codexHome` für Doctor und Slice.
5. Der synthetische OpenSSH-E2E-Test besteht vollständig.
6. Der reale Auth-Persistenztest mit lokalem Codex-Login besteht, sofern die
   lokale private `auth.json` vorhanden ist; in der Abnahmeumgebung ist sie
   vorhanden.
7. Der Benchmark besteht innerhalb aller vier Budgets.
8. Typecheck, Bundle-Reproduzierbarkeit, Plugin-Validierung und Audit sind grün.
9. CI ist grün, PR ist in `main` gemergt.
10. Marketplace-Plugin 1.4.0 ist installiert, aktiviert, MCP verbunden und
    `orchestrator_doctor` meldet einen gesunden lokalen Target-Zustand.

## Nichtziele

- Kein dauerhafter SSH-Daemon und keine dauerhafte Änderung an
  `~/.ssh/config`.
- Keine Speicherung oder Ausgabe echter Tokeninhalte.
- Kein externer Cloud-Host ohne vom Nutzer bereitgestellte Infrastruktur.
- Kein kostenpflichtiger Codex-Modellturn im Real-Auth-Abnahmemodus.
