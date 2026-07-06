# Issue-Governance und Abhängigkeitsdesign

Datum: 2026-07-06  
Status: zur Abnahme  
Repository: `tomtastisch/codex-orchestrator`

## 1. Ziel

Die offenen GitHub-Issues werden so konsolidiert, dass sie den aktuellen Codezustand
korrekt beschreiben, keine Verantwortlichkeiten duplizieren und in umsetzbaren,
prüfbaren Slices abgearbeitet werden können.

Das Design legt verbindlich fest:

- welche fachliche Verantwortung jedes Issue besitzt;
- welche Beziehungen echte technische Blockaden sind;
- welche übergeordneten Issues ausschließlich als Epics dienen;
- welche großen Arbeitspakete in kleinere Teil-Issues zerlegt werden;
- in welcher Reihenfolge die Issues interaktiv geprüft und aktualisiert werden;
- wie jede Änderung auf GitHub technisch verifiziert wird.

Implementierungscode ist nicht Bestandteil dieser Konsolidierung.

## 2. Verifizierter Ist-Zustand

### 2.1 Repository

- `src/server.ts` umfasst 1.007 Zeilen.
- Der Server registriert 17 MCP-Tools und zwei MCP-Prompts.
- Tool-Registrierung, Dependency Wiring und umfangreiche Handler-Logik liegen
  gemeinsam in `src/server.ts`.
- Direkte Persistenzzugriffe außerhalb der eigentlichen Store-Implementierung
  existieren mindestens in `src/statemachine.ts`, `src/artifact.ts` und im
  Hypothesen-Repository.
- Sicherheitsfunktionen existieren bereits verteilt über Sandbox-Prüfung,
  Redaction, Projektgrenzen, Worker-Pfadprüfung, allowlist-basierte Checks,
  Runtime-Prozessgrenzen und restriktive Netzwerkvorgaben.
- Issue #25 darf deshalb nicht als Greenfield-Implementierung beschrieben werden.

### 2.2 Qualitätssicherung

- Die Ausgangssuite besteht aus 153 erfolgreichen Tests.
- Die CI prüft Node.js 22 unter Ubuntu.
- Die Remote-Akzeptanz läuft unter macOS 15.
- Ein Coverage-Skript existiert, ist aber kein verbindliches CI-Gate.
- Eine Windows-CI-Matrix und eine eigenständige statische Analyse fehlen.

### 2.3 GitHub-Issues

Offen sind die Issues #16 bis #27. Native GitHub-Abhängigkeiten waren vor dieser
Konsolidierung nur für die Kette `#17 -> #18 -> #16` teilweise gesetzt. Weitere
Abhängigkeiten standen nur als Text in den Beschreibungen.

GitHub stellt dafür zwei unterschiedliche Beziehungstypen bereit:

- Sub-Issues für die Zerlegung eines Epics;
- `Blocked by` beziehungsweise `Blocking` für technisch zwingende Reihenfolgen.

Diese Beziehungstypen werden nicht austauschbar verwendet.

## 3. Entscheidungsgrundsätze

### 3.1 Harte Blockade

Eine native `Blocked by`-Beziehung wird nur gesetzt, wenn das nachgelagerte Issue
ohne das Ergebnis des Vorgängers technisch nicht korrekt oder nur mit absehbarer
Nacharbeit umgesetzt werden könnte.

Zeitliche Präferenz, thematische Nähe oder gemeinsame Dokumentation reichen nicht
für eine harte Blockade.

### 3.2 Epic und Sub-Issue

Ein Epic enthält Ziel, Grenzen, Teil-Issues und gemeinsame Abschlusskriterien. Es
enthält keine zweite vollständige Implementierungsanleitung neben seinen
Sub-Issues.

Das Epic selbst erhält keine künstliche `Blocked by`-Beziehung zu allen Kindern.
Der Fortschritt wird über native Sub-Issues abgebildet.

### 3.3 Scope-Eindeutigkeit

Jede Verantwortung besitzt genau einen fachlichen Eigentümer:

| Verantwortung | Eigentümer |
|---|---|
| Runtime-, Tool- und Versionsdiagnose | #17 |
| Lokale und Execution-Target-Authentifizierung | #18 |
| MCP-Tool-/Prompt-Registrierung | #19 |
| Application-, Port-, Adapter- und Composition-Root-Grenzen | #27 |
| Persistenz-Port und SQLite-Adapter | #20 |
| Konsolidierte Security-Policy und Security-Gates | #25 |
| Grenzfall- und Sicherheitstests | #21 |
| Messwertbasierte Laufzeithärtung | #22 |
| CI-, Coverage-, Plattform- und statische Qualitätsbaseline | #23 |
| Contributor-, Entwicklungs- und Security-Dokumentation | #24 |
| GitHub-/CI-/Copilot-Gesamtziel | #16 als Epic |
| Gesamt-Roadmap | #26 als Master-Epic |
| Claude.ai Remote MCP | neues Remote-MCP-Epic |

## 4. Verbindlicher Abhängigkeitsgraph

### 4.1 Bestehende Haupt-Issues

| Issue | Native Blockade |
|---|---|
| #23 Qualitätsbaseline | keine |
| #24 Projektdokumentation | blocked by #23 |
| #19 MCP-Registrierungsmodularisierung | blocked by #23 |
| #27 Ports-und-Adapter-Grundstruktur | blocked by #19 |
| #17 Environment Doctor | blocked by #19 |
| #18 Auth-Onboarding | blocked by #17 |
| #20 Persistence-Port | blocked by #27 |
| #25 Security-Konsolidierung | blocked by #20 |
| #21 Grenzfalltests | blocked by #25 |
| #22 Performance-Härtung | blocked by #21 |
| #16 GitHub-/CI-/Copilot-Epic | keine direkte Blockade; Fortschritt über Sub-Issues |
| #26 Master-Epic | keine direkte Blockade; Fortschritt über Sub-Issues |

### 4.2 GitHub-/CI-/Copilot-Epic #16

#16 wird auf Epic-Scope reduziert. Es erhält diese vier nativen Sub-Issues:

| Design-ID | Titel | Native Blockade |
|---|---|---|
| GH-A | GitHub-Preflight, Commit-Plan und PR-Lifecycle | blocked by #18, #23 und #25 |
| GH-B | PR-Beschreibungssynchronisierung und CI-Gate | blocked by GH-A |
| GH-C | Copilot-Review anfordern, erkennen und erfassen | blocked by GH-B |
| GH-D | Findings klassifizieren, Korrekturschleife und Merge-Gate | blocked by GH-C |

Die Design-IDs bleiben in der Spezifikation stabil. Nach Erstellung ersetzt #16
sie durch die von GitHub vergebenen Issue-Nummern und Links.

### 4.3 Claude.ai-Remote-MCP-Epic

Für Remote MCP wird ein neues Epic angelegt. Es erhält diese drei nativen
Sub-Issues:

| Design-ID | Titel | Native Blockade |
|---|---|---|
| RM-A | Wiederverwendbare Runtime und Streamable-HTTP-Transport | blocked by #23 und #27 |
| RM-B | OIDC-Validierung, Tool-Scopes und Remote-Security-Policy | blocked by RM-A und #25 |
| RM-C | Container-Deployment, persistente Host-Auth und Ende-zu-Ende-Abnahme | blocked by RM-B und #18 |

Remote-MCP-OIDC gehört ausschließlich zu RM-B. Es wird nicht in #18 vermischt.
#18 bleibt für Codex-, GitHub- und Execution-Target-Authentifizierung zuständig.

### 4.4 Master-Epic #26

#26 erhält als native Sub-Issues:

- #23 und #24;
- #19, #27, #20, #25, #21 und #22;
- #17 und #18;
- #16;
- das neue Remote-MCP-Epic.

Die Teil-Issues von #16 und des Remote-MCP-Epics werden nicht zusätzlich direkt
unter #26 dupliziert. Dadurch bleibt die Hierarchie eindeutig.

## 5. Verbindliche Scope-Korrekturen

### 5.1 #23 – Qualitätsbaseline

#23 wird als erstes Arbeitspaket umgesetzt. Das Issue definiert eine
reproduzierbare Ausgangsbasis vor Architekturänderungen:

- Coverage-Erfassung und begründete Mindestschwellen;
- unterstützte Plattformen und CI-Matrix;
- TypeScript-Typprüfung, Bundle-, MCPB- und Plugin-Validierung;
- statische Analyse und Abhängigkeitsprüfung;
- reproduzierbare Build-Artefakte;
- klare Trennung von Pflicht-Gates und plattformspezifischen Akzeptanztests.

#23 enthält keine noch nicht implementierte Security-Schicht als Voraussetzung.
Spätere Issues müssen ihre neuen Module in die etablierte Qualitätsbaseline
integrieren.

### 5.2 #24 – Projekt- und Security-Dokumentation

#24 beschränkt sich auf dauerhafte Maintainer-Dokumentation:

- `CONTRIBUTING.md`;
- `SECURITY.md` mit vertraulichem Meldeweg;
- lokale Entwicklungs- und Testbefehle;
- Plattform- und Release-Prüfungen aus #23;
- Regeln für Secrets und Security-Findings.

Produktstatus und Roadmap werden nicht redundant in mehreren Dateien gepflegt.

### 5.3 #19 – MCP-Registrierungsmodularisierung

#19 ist ein verhaltensneutrales Refactoring:

- Tool- und Prompt-Verträge inventarisieren und durch Contract-Tests schützen;
- Registrierungen fachlich gruppieren;
- Abhängigkeiten explizit an Registrar-Funktionen übergeben;
- Servererstellung wiederholbar und testbar machen;
- `src/server.ts` als kompatiblen Entry Point erhalten.

#19 definiert keine Domain-Ports und migriert keine Fachlogik in Use-Cases. Diese
Verantwortung liegt ausschließlich bei #27.

### 5.4 #27 – Inkrementelle hexagonale Grundstruktur

#27 baut auf den Registraren aus #19 auf:

- Composition Root und Runtime-Lebenszyklus trennen;
- eine erste vollständige vertikale Application-Use-Case-Extraktion durchführen;
- nur Ports einführen, die von dieser Extraktion tatsächlich benötigt werden;
- Import-Richtungen durch Architekturtests schützen;
- keine leeren oder spekulativen Adapterstrukturen anlegen.

Die bisher vorgesehene pauschale Anlage zahlreicher ungenutzter Ports entfällt.

### 5.5 #17 – Environment Doctor

#17 erweitert den vorhandenen `orchestrator_doctor` statt ein konkurrierendes
Doctor-System einzuführen:

- Runtime und Plattform erkennen;
- erforderliche Binärdateien und Versionen prüfen;
- Git-Repository-Grundzustand erfassen;
- paketmanagerabhängige, allowlist-basierte nächste Schritte erzeugen;
- Claude-Desktop-MCPB korrekt von externen Node-Anforderungen abgrenzen;
- niemals Systempakete aus dem MCP-Server installieren.

#17 definiert keine Auth-Ergebnisse. #18 ergänzt die Environment-Diagnose später
um getrennte Auth-Capabilities. `gh auth`, `codex login` und
Berechtigungsprüfung gehören nicht zu #17.

### 5.6 #18 – Auth-Onboarding

#18 verarbeitet Authentifizierung ohne Secrets im Modellkontext:

- `codex login status` für lokale und konfigurierte Execution Targets;
- `gh auth status`, Host, Account und erkennbare Token-Scopes;
- sichere, interaktive Login-Anweisungen;
- Re-Check und fail-closed Capability-Flags;
- redigierte Audit- und Snapshot-Zustände;
- keine Ausgabe oder Chat-Übertragung von Token, OAuth-Code oder `auth.json`.

Remote-Connector-OIDC gehört nicht zu #18.
Repositorybezogene Push-, PR-, Check- und Review-Berechtigungen werden erst in
GH-A geprüft und nicht in #18 vorweggenommen.

### 5.7 #20 – Persistence-Port

#20 beseitigt konkret nachgewiesene Persistenzleaks:

- State-Machine-Zugriffe auf interne DB-Handles;
- Artifact-Abfragen auf interne Tabellen;
- unklare Store-/Repository-Grenzen der Hypothesenlogik;
- untypisierte oder nicht atomare Gate-Abfragen.

SQLite bleibt der einzige produktive Adapter. Eine Backend-Migration ist kein
Ziel.

### 5.8 #25 – Security-Konsolidierung

#25 konsolidiert vorhandene Schutzmechanismen:

- Sandbox-Policy;
- Projekt- und Pfadgrenzen;
- Command-Allowlist;
- Network-Policy;
- Secret-Redaction;
- Audit- und Artifact-Integrität.

Das Issue identifiziert zuerst alle existierenden Enforcement-Pfade und führt
danach eine gemeinsame Security-Policy-Fassade ein. Kritische Operationen dürfen
die konsolidierte Policy nicht umgehen. Ein vollständiger Container-, VM- oder
VPN-Zwang bleibt außerhalb des Scopes.

### 5.9 #21 und #22

#21 ergänzt deterministische Grenzfalltests für Store, Wait, Cancel, große Diffs,
Security-Entscheidungen und Artefaktgrenzen. #22 optimiert ausschließlich auf
Basis reproduzierbarer Messwerte aus diesen Tests. Security-Gates dürfen für
Benchmarks nicht deaktiviert werden.

### 5.10 #16 – GitHub-/CI-/Copilot-Epic

#16 enthält nach der Zerlegung nur noch:

- fachliches Gesamtziel;
- Rollenabgrenzung von Claude, Codex, CI und Copilot;
- Links auf GH-A bis GH-D;
- epicweite Sicherheits- und Abschlusskriterien.

Detailmodelle, Tabellen und Cluster liegen ausschließlich in den Teil-Issues.

### 5.11 #26 – Master-Epic

#26 enthält:

- die aktuelle Hierarchie;
- den harten Abhängigkeitsgraph;
- den Status jedes direkten Sub-Issues;
- Regeln für Reihenfolge, Abnahme und Abschluss.

#26 implementiert keine Produktfunktion und ist durch kein Kind blockiert.

## 6. Aktualisierungs- und Abnahmeverfahren

Die GitHub-Aktualisierung erfolgt interaktiv in dieser Reihenfolge:

1. #23;
2. #24;
3. #19;
4. #27;
5. #17;
6. #18;
7. #20;
8. #25;
9. #21;
10. #22;
11. #16 und GH-A bis GH-D;
12. Remote-MCP-Epic und RM-A bis RM-C;
13. #26.

Für jedes Issue gilt:

1. aktuellen Body unmittelbar vor der Änderung erneut lesen;
2. Ziel, Scope, Nicht-Ziele, Abhängigkeiten und Akzeptanzkriterien konsolidieren;
3. Änderung online durchführen;
4. aktualisierten Body zurücklesen;
5. native `Blocked by`- und Sub-Issue-Beziehungen setzen;
6. Beziehungen per GraphQL zurücklesen;
7. Ergebnis dem Nutzer zur Einzelabnahme vorlegen;
8. erst nach Freigabe mit dem nächsten Issue fortfahren.

## 7. Qualitätskriterien für alle Issue-Beschreibungen

Jedes umsetzbare Issue enthält:

- eindeutiges Ziel;
- belegten Ist-Zustand;
- expliziten Scope;
- explizite Nicht-Ziele;
- technisch begründete Abhängigkeiten;
- geclusterte, sequenzielle Aufgaben;
- messbare Akzeptanzkriterien;
- konkrete Verifikationskommandos oder Verifikationsarten;
- Sicherheits- und Rückwärtskompatibilitätsgrenzen;
- eindeutige Abschlussbedingung.

Unzulässig sind:

- doppelte fachliche Eigentümerschaft;
- unbestimmte Begriffe wie „gegebenenfalls“ ohne Entscheidungskriterium;
- spekulative Technologien ohne Adaptergrenze;
- `Blocked by` nur wegen zeitlicher Präferenz;
- Akzeptanzkriterien für Funktionen außerhalb des Issue-Scopes;
- unprüfbare Aussagen wie „vollständig“, „optimal“ oder „produktionsreif“ ohne
  definierte Evidenz.

## 8. Sicherheitsgrenzen der GitHub-Aktualisierung

- Keine Secrets oder lokalen Pfade mit Credential-Inhalt werden in Issues
  geschrieben.
- Vorhandene Issue-Kommentare werden nicht gelöscht.
- Nur die Issue-Beschreibung, native Beziehungen und neu erforderliche
  Teil-Issues werden geändert.
- Jede native Beziehung wird nach dem Schreiben zurückgelesen.
- Bei GraphQL- oder Berechtigungsfehlern wird die Serie gestoppt; es gibt keinen
  textuellen Scheinersatz für eine fehlgeschlagene native Beziehung.

## 9. Abschlusskriterien der Governance-Konsolidierung

Die Konsolidierung ist abgeschlossen, wenn:

- alle bestehenden Issues den tatsächlichen Codezustand beschreiben;
- #16 und das Remote-MCP-Vorhaben in umsetzbare Sub-Issues zerlegt sind;
- #26 alle direkten Epics und Arbeitspakete als native Sub-Issues enthält;
- jede harte Abhängigkeit in GitHubs rechter Relationships-Seitenleiste sichtbar
  ist;
- keine zyklische `Blocked by`-Beziehung existiert;
- textuelle Abhängigkeitsangaben und native Beziehungen übereinstimmen;
- jedes Issue eine eindeutige Verantwortung und messbare Abnahme besitzt;
- der Nutzer jedes Issue interaktiv einzeln abgenommen hat;
- eine abschließende Gesamtprüfung Scope-Lücken, Duplikate und widersprüchliche
  Reihenfolgen ausschließt.
