# Plattformübergreifende Distribution: Design

## Ziel

Codex Orchestrator wird ausgehend von Version 1.4.0 in drei aufeinander
aufbauenden, getrennt abnehmbaren Releases für Claude Code, Claude Desktop und
claude.ai bereitgestellt. Alle Varianten verwenden dieselbe Orchestrator-
Kernlogik und dieselben Sicherheitsgrenzen. Plattformadapter enthalten nur
Transport-, Paketierungs- und Authentifizierungslogik.

## Verbindliche Produktentscheidungen

1. Claude Code bleibt die primäre und bereits produktionsbereite Variante.
2. Das aktuelle Claude-Desktop-Paketformat heißt MCPB; DXT wird nur noch als
   frühere Bezeichnung erwähnt.
3. Der claude.ai-Connector wird als selbst gehostete Single-Tenant-Lösung
   gebaut. Es entsteht kein zentraler Multi-Tenant-Dienst und kein zentraler
   Credential-Speicher.
4. Der Orchestrator speichert niemals Codex-Credentials in Repository,
   Manifest, URL, Prozessargumenten, MCP-Ergebnissen oder Logs.
5. Jeder Plattformstand erhält einen eigenen Release, PR, vollständige
   Abnahme und ein reproduzierbares Distributionsartefakt.

## Supportstatus und Releasefolge

| Plattform | Ist-Zustand | Zielrelease | Zielstatus |
|---|---|---:|---|
| Claude Code CLI | Plugin 1.4.0 installiert und geprüft | 1.4.1 | Produktionsbereit |
| Claude Desktop | Kein MCPB-Artefakt | 1.5.0 | Produktionsbereit als lokale Erweiterung |
| claude.ai | Kein HTTP-Transport und kein OAuth | 1.6.0 | Produktionsbereit als selbst gehosteter Connector |

Während der Umsetzung verwendet die README ausschließlich die Statuswerte
`Produktionsbereit`, `In Entwicklung` und `Nicht unterstützt`. Ein Status wird
erst nach bestandenen Release-Gates auf `Produktionsbereit` gesetzt.

## Gemeinsame Architektur

Die aktuell in `src/server.ts` gekoppelte Servererzeugung, Laufzeitinitialisierung
und stdio-Verbindung wird in klar getrennte Einheiten überführt:

- `createOrchestratorServer(runtime)`: registriert Tools und MCP-Prompts;
- `createOrchestratorRuntime(config)`: erzeugt Store, Execution-Registry,
  SessionManager, Zustandsmaschine und Shutdown-Hooks;
- `src/transports/stdio.ts`: lokale Claude-Code- und MCPB-Verbindung;
- `src/transports/http.ts`: Streamable-HTTP-Verbindung für claude.ai;
- kleine ausführbare Entrypoints wählen genau einen Transport.

Toolnamen, Eingabeschemata, Zustandsübergänge, Redaction und Sandboxregeln
bleiben transportneutral. Contract-Tests führen dasselbe Toolinventar gegen
stdio, MCPB und HTTP aus.

Zusätzlich registriert der gemeinsame Server zwei MCP-Prompts:

- `codex_orchestrator`: startet den beaufsichtigten Clusterworkflow;
- `orchestrator_status`: zeigt den aktuellen Plan- und Taskstatus.

Claude Code behält seine namespaced Plugin-Skills. Desktop und claude.ai
erhalten dieselbe fachliche Einstiegshilfe über MCP-Prompts, soweit der jeweilige
Client Prompts darstellt. Es wird nicht behauptet, dass Claude Desktop dieselbe
Slash-Command-Namenssyntax wie Claude Code bereitstellt.

## Release 1.4.1: README und Claude Code

### Dokumentationsstruktur

Die README beginnt nach der Produkteinführung mit:

1. Supportmatrix;
2. Voraussetzungen;
3. Schnellstart für Claude Code;
4. Installationsprüfung;
5. Update und Deinstallation;
6. Claude-Desktop- und claude.ai-Roadmap;
7. Sicherheits- und Credentialmodell.

### Voraussetzungen

Für Claude Code werden verbindlich genannt:

- macOS, Linux oder Windows in einer von Claude Code unterstützten Umgebung;
- Node.js mindestens 22.13, weil `node:sqlite` erst ab 22.13 ohne zusätzliches
  Startflag verfügbar ist;
- Git;
- installierte Codex CLI;
- erfolgreicher `codex login status`;
- lokal installiertes und angemeldetes Claude Code CLI;
- Schreibrechte im benutzerspezifischen Claude-Plugin-Cache.

Claude Desktop ist keine Voraussetzung für das Claude-Code-Plugin. Die README
stellt ausdrücklich klar, dass die Begriffe Claude Code CLI, Claude Desktop und
claude.ai unterschiedliche Laufzeitmodelle bezeichnen.

### Installation und Verifikation

Der produktive Terminalweg bleibt:

```bash
claude plugin marketplace add tomtastisch/codex-orchestrator
claude plugin install codex-orchestrator@codex-orchestrator --scope user
```

Die README dokumentiert außerdem nichtinteraktive Befehle für Update,
Deinstallation, Pluginliste, MCP-Gesundheit und die beiden namespaced
Slash-Commands. Eine grafische Installation ist erst für MCPB vorgesehen und
wird nicht für das Claude-Code-Plugin behauptet.

### Offizieller Marketplace

Das vorhandene GitHub-Marketplace-Repository bleibt der sofort nutzbare
Distributionsweg. Zusätzlich wird eine Einreichung für den offiziellen
`claude-plugins-official`-Marketplace vorbereitet. Die README unterscheidet:

- `Verfügbar`: selbst gehosteter GitHub-Marketplace;
- `Eingereicht`: Formular wurde an Anthropic übertragen;
- `Offiziell gelistet`: nur nach nachweisbarer Anthropic-Aufnahme.

Repositorytexte dürfen den eigenen Marketplace nicht als offiziellen Anthropic-
Marketplace bezeichnen. Die bestehende Marketplace-Beschreibung wird daher von
`Official marketplace` auf `First-party marketplace` geändert.

### Release-Gates

- alle bestehenden Tests;
- README-Linkprüfung für interne Ziele und zentrale externe Quellen;
- strikte Pluginvalidierung;
- Neuinstallation aus dem GitHub-Marketplace;
- zwei sichtbare Claude-Code-Komponenten;
- verbundener MCP und gesunder `orchestrator_doctor`;
- GitHub-Release 1.4.1.

## Release 1.5.0: Claude Desktop MCPB

### Paketformat

Das Repository erhält `packaging/mcpb/` mit:

- `manifest.json` nach aktueller MCPB-Spezifikation;
- dem reproduzierbar erzeugten `bundle/server.mjs`;
- Lizenz, Kurzbeschreibung und Installationshinweisen;
- optionalen, repository-eigenen Icons ohne fremde Markenrechte.

Das erzeugte Releaseartefakt heißt
`codex-orchestrator-<version>.mcpb`. Das Paket enthält keine Entwicklungsdateien,
Tests, `.git`-Daten, Credentials oder unbenötigte Abhängigkeiten.

### Laufzeit und Konfiguration

Claude Desktop startet den Node-Entrypoint lokal über stdio. Der Host stellt
Node bereit; Codex CLI und Git müssen auf dem lokalen System im `PATH` liegen.
Konfigurierbar sind ausschließlich validierte Werte wie `ORCH_HOME`,
`ORCH_CODEX_BIN` und optional `ORCH_CONFIG_FILE`.

Credentials werden nicht über MCPB-`user_config` abgefragt. Anwender führen
`codex login` außerhalb von Claude Desktop aus. Der Doctor erklärt fehlende CLI,
fehlende Anmeldung und ungültige Konfiguration ohne Secret-Ausgabe.

### Packaging und Tests

- MCPB-CLI wird versionsgepinnt als Dev-Dependency verwendet;
- `npm run mcpb:pack` erzeugt das Artefakt deterministisch;
- Manifest-Schema und Paketinhalt werden in Tests geprüft;
- Bundle-Hash muss mit dem geprüften Release-Bundle übereinstimmen;
- Smoke-Test entpackt das MCPB in ein temporäres Verzeichnis und führt MCP-
  Handshake, Toolinventar und Doctor mit Fake-Codex aus;
- ein lokaler manueller Test installiert das Releaseartefakt in Claude Desktop;
- CI veröffentlicht SHA-256-Prüfsumme und Artefakt erst nach allen Gates.

### Veröffentlichung

- GitHub-Release 1.5.0 mit `.mcpb` und `.sha256`;
- README-Downloadlink auf das versionsgebundene Release;
- Vorbereitung der Claude-Desktop-Directory-Einreichung;
- Status `Produktionsbereit` erst nach erfolgreicher Installation des finalen
  Releaseartefakts in einer aktuellen Claude-Desktop-Version.

## Release 1.6.0: Selbst gehosteter Remote-MCP für claude.ai

### Betriebsmodell

Jede Installation bedient genau einen Betreiber und dessen Repositories. Der
Dienst läuft auf einem vom Betreiber kontrollierten Linux-Host mit:

- öffentlichem HTTPS-Domainnamen;
- persistentem Codex-Home;
- lokal installiertem oder im Image enthaltenem Codex CLI;
- explizit gemounteten Repository-Wurzeln;
- persistentem Orchestrator-Store;
- externem OAuth/OIDC-Provider.

Der Betreiber authentifiziert Codex direkt auf diesem Host. `auth.json` wird
nicht über claude.ai, OAuth, MCP oder ein Deploymentformular übertragen.

### HTTP-Transport

- ausschließlich Streamable HTTP unter `/mcp`;
- Gesundheitsendpunkte `/health/live` und `/health/ready` ohne sensitive Daten;
- begrenzte Requestgröße, Header- und Body-Timeouts;
- per Session isolierte MCP-Transports mit deterministischer Bereinigung;
- keine permissive CORS-Konfiguration;
- Reverse-Proxy-Unterstützung nur mit explizit konfigurierten Trusted Proxies;
- TLS endet am dokumentierten Reverse Proxy oder direkt am Dienst.

SSE wird nicht neu implementiert. Der Connector folgt der von Anthropic
unterstützten Streamable-HTTP-Richtung.

### OAuth/OIDC

Die Anwendung ist ein OAuth-geschützter MCP Resource Server:

- verpflichtende HTTPS-Issuer- und Audience-Konfiguration;
- JWT-Signaturprüfung über gecachte JWKS;
- Prüfung von `iss`, `aud`, `exp`, `nbf` und erforderlichen Scopes;
- minimale Scopes `orchestrator:read` und `orchestrator:write`;
- Write-Tools benötigen den Write-Scope;
- keine Tokens in Logs, Events oder SQLite;
- Tokenwiderruf erfolgt über den Betreiber-IdP;
- Protected-Resource-Metadata wird standardkonform veröffentlicht.

Der Referenzbetrieb dokumentiert einen kompatiblen OIDC-Provider. Claude kann
mit einem dort registrierten Client und der Callback-URL
`https://claude.ai/api/mcp/auth_callback` verbunden werden. Ein eingebauter
Passwort-, Benutzer- oder Multi-Tenant-Accountdienst ist ausdrücklich nicht
Teil des Produkts.

### Container und Deployment

Das Repository erhält:

- multi-stage `Dockerfile` mit unprivilegiertem Laufzeitbenutzer;
- `compose.yaml` als Single-Tenant-Referenz;
- `.env.example` ausschließlich mit Platzhaltern;
- read-only Root-Filesystem, wo technisch möglich;
- separate persistente Volumes für Codex-Home und Orchestrator-State;
- explizite Repository-Mounts;
- Capability-Drop, `no-new-privileges`, Ressourcenlimits und Healthchecks;
- dokumentierte Secret-Manager- und Backup-/Restore-Verfahren.

Keine Compose-Datei enthält Token, Client-Secret oder `auth.json`. Sensible
Werte werden als Secret-Dateien oder durch den Deployment-Secret-Manager
bereitgestellt.

### Remote-Tests

- unit tests für Auth-Metadaten und JWT-Validierung;
- Ablehnung fehlender, abgelaufener, falsch signierter und falsch adressierter
  Tokens;
- Scope-Matrix für jedes Tool;
- HTTP-Contract-Test mit MCP-Client;
- Restart-Test für State und Codex-Auth;
- Redaction-Canaries in Headern, Bodies, Fehlern und Auditlog;
- Container-Smoke-Test als unprivilegierter Benutzer;
- MCP Inspector gegen das Releaseimage;
- manueller Connector-Test in claude.ai durch den Betreiber.

### Veröffentlichung

- GitHub-Release 1.6.0;
- signiertes Containerimage mit unveränderlichem Versions- und Digest-Tag;
- SBOM, Provenienz und SHA-256-Nachweise;
- dokumentierte Connector-URL und OAuth-Einrichtung;
- Vorbereitung einer Anthropic-Connectors-Directory-Einreichung;
- keine Behauptung offizieller Listung vor Anthropic-Freigabe.

## Sicherheitsgrenzen

- `danger-full-access` bleibt unerreichbar.
- Netzwerkzugriff für Codex-Slices bleibt standardmäßig deaktiviert.
- Git- und Check-Kommandos bleiben argv-basiert und allowlisted.
- Remote-MCP erweitert nicht automatisch die erlaubten Repository-Wurzeln.
- Authentifizierter Zugriff ersetzt nicht die bestehenden Review-, Sandbox- und
  Cluster-Gates.
- MCP-Client-Inhalte gelten als nicht vertrauenswürdig und durchlaufen weiterhin
  Zod-Schemata, Größenlimits und Redaction.
- Selbst-Hosting bedeutet, dass der Betreiber für Host-Härtung, Domain, TLS,
  IdP, Backups und Codex-Nutzungsberechtigung verantwortlich bleibt.

## CI- und Release-Governance

Die bestehenden Gates bleiben erhalten. Neue Jobs werden additiv ergänzt:

1. `claude-code`: Pluginvalidierung, Installation und MCP-Smoke-Test;
2. `mcpb`: Manifest, reproduzierbares Paket, entpackter Smoke-Test;
3. `remote-http`: HTTP-, OAuth- und Scope-Contract-Tests;
4. `container`: Build, unprivilegierter Start, Healthcheck und Scan;
5. `release`: Prüfsummen, SBOM, Provenienz und versionsgebundene Artefakte.

Ein Release wird nur aus einem signierten oder GitHub-seitig attestierten Tag
erzeugt. Buildartefakte werden nicht manuell ersetzt. Versionsnummern in Paket,
Lockfile, Pluginmanifest, MCPB-Manifest, Runtime und Containerlabels müssen
übereinstimmen.

## Sequenz und Abnahme

Die Releases werden strikt nacheinander umgesetzt:

1. 1.4.1 vollständig testen, veröffentlichen und installieren;
2. erst danach 1.5.0 entwickeln, testen, veröffentlichen und installieren;
3. erst danach 1.6.0 entwickeln, testen, deployen und mit claude.ai verbinden.

Externe Anthropic-Einreichungen sind schreibende Fremdsystemaktionen. Sie
werden erst nach bestandenen lokalen und CI-Gates ausgeführt. Formularannahme
gilt als `Eingereicht`; nur eine sichtbare Aufnahme gilt als `Offiziell
gelistet`.

## Nichtziele

- kein zentral betriebener Multi-Tenant-SaaS;
- keine Übertragung lokaler Credentials an Claude oder den Repositorybetreiber;
- kein anonymer öffentlicher Remote-MCP;
- keine künstliche Gleichsetzung von Claude-Code-Skills und Desktop-Prompts;
- keine rückwirkende Behauptung einer Anthropic-Zertifizierung;
- keine parallele Neuimplementierung der Orchestrator-Fachlogik.

## Referenzen

- Claude Code Plugins und offizieller Marketplace:
  https://code.claude.com/docs/en/discover-plugins
- Claude Code Marketplace-Distribution:
  https://code.claude.com/docs/en/plugin-marketplaces
- MCPB-Spezifikation und Toolchain:
  https://github.com/modelcontextprotocol/mcpb
- Claude Desktop lokale Erweiterungen:
  https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- claude.ai Remote-MCP und OAuth:
  https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers
- MCP TypeScript SDK Server- und Transportleitfaden:
  https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
