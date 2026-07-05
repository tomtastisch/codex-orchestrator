# Remote Execution und Produktionsreife: Umsetzungsplan

> Für agentische Worker: Vor der Implementierung ist der Workflow
> `superpowers:test-driven-development` erforderlich. Der Plan wird
> taskweise ausgeführt; nach jedem Task müssen die angegebenen Checks und ein
> eigener Commit vorliegen.

Ziel: Das Claude-Code-Plugin erhält sichere Remote-Ausführung über SSH,
connectivity-only Local-Fallback, geschützten Auth-Bootstrap, belastbare
Diagnostik und eine einreichungsfähige Release-Pipeline.

Architektur: Der MCP-Server bleibt Eigentümer von Zustand und Routing. Eine
`ExecutionTarget`-Schnittstelle kapselt Codex-, Git-, Check- und Worktree-
Operationen. Das SSH-Target spricht ausschließlich mit einem versionierten,
schema-validierten Worker; Tasks werden unveränderlich an ein Target gebunden.

Tech Stack: TypeScript, Node.js 22, MCP SDK, Zod, `node:sqlite`, OpenSSH,
Node-Test-Runner, ESLint, esbuild, Claude-Code-Plugin-Manifeste.

Designgrundlage:
`docs/superpowers/specs/2026-07-05-remote-execution-production-design.md`

---

## Dateistruktur nach Umsetzung

Neue Kernmodule:

- `src/runtime/environment.ts`: minimale Kindprozess-Umgebung
- `src/runtime/process.ts`: getesteter Prozess-Lifecycle und Outputgrenzen
- `src/runtime/redaction.ts`: Redaktion vor Persistenz und Ausgabe
- `src/execution/types.ts`: Target-, Request-, Result- und Error-Typen
- `src/execution/local-target.ts`: lokale Implementierung
- `src/execution/router.ts`: Preflight, Targetwahl und Fallback
- `src/execution/ssh/client.ts`: SSH-Prozess und Fehlerklassifikation
- `src/execution/ssh/deploy.ts`: contentadressiertes Worker-Deployment
- `src/execution/ssh/target.ts`: Remote-Target
- `src/execution/ssh/protocol.ts`: Zod-Protokollschema
- `src/worker/server.ts`: begrenzter Remote-Worker
- `src/auth/status.ts`: redigierter Codex-Authstatus
- `src/auth/bootstrap.ts`: sichere, atomare Auth-Initialisierung
- `src/doctor.ts`: aggregierter, redigierter Preflight
- `src/db/migrations.ts`: versionierte SQLite-Migrationen
- `src/tools/*.ts`: fokussierte MCP-Tool-Registrierung

Bestehende Kernmodule:

- `src/codex.ts`: nur noch Argumentbau und Codex-Eventinterpretation
- `src/checks.ts`: Target-unabhängige Checkdefinitionen
- `src/worktree.ts`: Target-unabhängige Worktree-Requests
- `src/session.ts`: Slice-Orchestrierung, kein direkter Prozessstart
- `src/server.ts`: Composition Root und Lifecycle, keine Tool-Details
- `src/config.ts`: vollständig validierte Konfiguration
- `src/db.ts`: Store-Fassade über Migrationen und typisierte Rows

## Task 1: Baseline einfrieren und reproduzierbare Tests erzwingen

Dateien:

- Ändern: `package.json`
- Erstellen: `tests/baseline.test.mjs`
- Erstellen: `scripts/verify-bundle.mjs`

- [ ] Schritt 1: Fehlenden Baseline-Test schreiben

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package, lockfile and Claude plugin versions agree", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const plugin = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(plugin.version, pkg.version);
});
```

- [ ] Schritt 2: Fehlschlag verifizieren

Ausführen: `node --test tests/baseline.test.mjs`

Erwartet: Fehler `1.0.0 !== 1.1.0`.

- [ ] Schritt 3: Test- und Buildreihenfolge deterministisch machen

`package.json` erhält:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "pretest": "npm run build",
    "test": "node --test tests/*.test.mjs",
    "test:coverage": "node --experimental-test-coverage --test tests/*.test.mjs",
    "bundle": "esbuild src/server.ts --bundle --platform=node --target=node22 --format=esm --outfile=bundle/server.mjs --external:node:* --banner:js=\"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\"",
    "bundle:worker": "esbuild src/worker/server.ts --bundle --platform=node --target=node22 --format=esm --outfile=bundle/worker.mjs --external:node:*",
    "verify:bundle": "node scripts/verify-bundle.mjs"
  }
}
```

- [ ] Schritt 4: Lockfile ausschließlich aus den Manifests aktualisieren

Ausführen: `npm install --package-lock-only --ignore-scripts`

Erwartet: `package-lock.json` meldet an beiden Root-Stellen Version `1.1.0`.

- [ ] Schritt 5: Bundle-Prüfer implementieren

Der Prüfer baut in ein temporäres Verzeichnis, vergleicht Bytes und beendet
sich bei Abweichung mit Exitcode 1. Er verwendet `spawnSync` mit argv und keine
Shell.

```js
/** @typedef {{ status: number | null, stderr: string | Buffer }} SpawnResult */
const args = [
    "src/server.ts", "--bundle", "--platform=node", "--target=node22",
    "--format=esm", `--outfile=${candidate}`, "--external:node:*",
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
];
```

- [ ] Schritt 6: Baseline verifizieren

Ausführen: `npm run typecheck && npm test && npm run verify:bundle`

Erwartet: alle Befehle erfolgreich.

- [ ] Schritt 7: Commit

```bash
git add package.json package-lock.json tests/baseline.test.mjs scripts/verify-bundle.mjs
git commit -m "test: make build and release metadata reproducible"
```

## Task 2: Sicherheitsregressionen zuerst als Tests erfassen

Dateien:

- Erstellen: `tests/security-boundaries.test.mjs`
- Ändern: `tests/statemachine.test.mjs`
- Ändern: `tests/config-agents.test.mjs`

- [ ] Schritt 1: Merge-Gate-Regressionstest schreiben

```js
test("cluster_merge prerequisites require confirmed review, checks and ownership", () => {
    assert.equal(canMerge({
        clusterStatus: "in_review",
        reviewStatus: "needs_changes",
        checksGreen: true,
        taskClusterId: "C1",
        clusterId: "C1",
        taskStatus: "completed",
    }).ok, false);
});
```

- [ ] Schritt 2: Read-only-Unveränderlichkeit testen

Der Test erstellt ein temporäres Git-Repository mit eigener `AGENTS.md`, ruft
die Vorbereitung eines read-only-Slices auf und vergleicht anschließend Inhalt
und `git status --porcelain` bytegenau.

- [ ] Schritt 3: Environment-Canary testen

```js
test("repository checks never inherit parent secrets", () => {
    const env = buildChildEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        OPENAI_API_KEY: "canary-secret",
        GITHUB_TOKEN: "canary-github",
    }, "repository-check");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
});
```

- [ ] Schritt 4: SIGTERM-Eskalation testen

Ein Fixture-Prozess ignoriert `SIGTERM`. Der Test erwartet nach Ablauf der
Grace-Period einen `SIGKILL` und einen einzigen terminalen Result-Callback.

- [ ] Schritt 5: Redaktions-Canaries testen

```js
test("redaction removes common credential forms", () => {
    const input = "Authorization: Bearer secret-value OPENAI_API_KEY=secret-value";
    assert.equal(redact(input).includes("secret-value"), false);
});
```

- [ ] Schritt 6: Erwartete Fehlschläge ausführen

Ausführen:
`npm run build && node --test --test-name-pattern="merge|read-only|secret|SIGTERM|redaction" tests/*.test.mjs`

Erwartet: neue Tests schlagen gezielt fehl, vorhandene Tests bleiben grün.

- [ ] Schritt 7: Commit

```bash
git add tests/security-boundaries.test.mjs tests/statemachine.test.mjs tests/config-agents.test.mjs
git commit -m "test: capture security and integrity boundaries"
```

## Task 3: Runtime-Konfiguration vollständig validieren

Dateien:

- Ändern: `src/config.ts`
- Erstellen: `src/config-schema.ts`
- Erstellen: `tests/config.test.mjs`

- [ ] Schritt 1: Schema-Tests schreiben

Abgedeckt werden `local-only`, `remote-only`, `remote-preferred`, unbekannte
Felder, negative Limits, `NaN`, ungültige SSH-Aliase, Repository-Mappings und
verbotene Secretfelder.

```js
assert.throws(
    () => parseConfig({ version: 1, execution: { mode: "remote-preferred", token: "secret" } }),
    /Unrecognized key|token/,
);
```

- [ ] Schritt 2: Diskriminierte Zod-Schemas implementieren

```ts
export const RemoteExecutionSchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    transport: z.literal("ssh"),
    host: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
    repository: z.object({
        localRoot: z.string().min(1),
        remoteRoot: z.string().min(1),
    }).strict(),
    codexBin: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("codex"),
    workerRoot: z.string().min(1).default("~/.cache/codex-orchestrator"),
    auth: z.discriminatedUnion("strategy", [
        z.object({ strategy: z.literal("existing") }).strict(),
        z.object({
            strategy: z.literal("sync-file"),
            source: z.string().min(1).optional(),
        }).strict(),
        z.object({
            strategy: z.literal("access-token"),
            secretCommand: z.array(z.string().min(1)).min(1),
        }).strict(),
    ]),
}).strict();
```

- [ ] Schritt 3: Numerische Envwerte validieren

`ORCH_MAX_CONCURRENT` und alle Limits verwenden `z.coerce.number().int().min(1)`.
Unzulässige Werte verhindern den Serverstart mit einer redigierten, konkreten
Fehlermeldung.

- [ ] Schritt 4: Keine Secrets im serialisierten Configobjekt zulassen

Die Schemafelder heißen nur `secretCommand` oder `source`; Tokenwerte sind
nicht darstellbar. `configForDiagnostics()` entfernt lokale absolute Pfade,
wenn die Tool-Antwort nicht ausdrücklich lokale Details verlangt.

- [ ] Schritt 5: Verifizieren

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern=config tests/*.test.mjs`

Erwartet: alle Config-Tests erfolgreich.

- [ ] Schritt 6: Commit

```bash
git add src/config.ts src/config-schema.ts tests/config.test.mjs
git commit -m "feat: validate execution configuration fail closed"
```

## Task 4: Sicheren Prozess-Lifecycle und minimale Environments bauen

Dateien:

- Erstellen: `src/runtime/environment.ts`
- Erstellen: `src/runtime/process.ts`
- Erstellen: `src/runtime/redaction.ts`
- Ändern: `src/codex.ts`
- Ändern: `src/checks.ts`
- Ändern: `tests/security-boundaries.test.mjs`

- [ ] Schritt 1: Environment-Allowlist implementieren

```ts
const COMMON_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"] as const;
const CODEX_ENV = ["CODEX_HOME", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"] as const;

export function buildChildEnvironment(
    source: NodeJS.ProcessEnv,
    purpose: "codex" | "repository-check" | "ssh",
): NodeJS.ProcessEnv {
    const allowed = purpose === "codex" ? [...COMMON_ENV, ...CODEX_ENV] : COMMON_ENV;
    return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}
```

Proxyvariablen werden nur über eine explizite, validierte Policy ergänzt. Checks
erhalten nie Codex-, GitHub-, Claude- oder Cloud-Credentials.

- [ ] Schritt 2: Prozess-Runner implementieren

`runManagedProcess()` kapselt Spawn, stdin, Abort, Timeout, Grace-Period,
inkrementelle Zeilenverarbeitung und exakt eine Promise-Auflösung.

```ts
const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
}, graceMs);
```

- [ ] Schritt 3: Output begrenzen

Der Runner hält höchstens 10.000 JSONL-Zeilen oder 10 MiB pro Slice. Ältere
Events werden nach dem Parsen verworfen. stderr behält maximal 64 KiB redigierten
Tail. Grenzüberschreitung liefert `TARGET_PROTOCOL` statt unkontrolliertem
Speicherwachstum.

- [ ] Schritt 4: Redaktion implementieren

Redigiert werden mindestens Bearer-Header, bekannte Secret-Envzuweisungen,
OpenAI-/GitHub-Tokenmuster, PEM-Schlüsselblöcke und Queryparameter wie
`access_token`. Die Funktion ist idempotent.

- [ ] Schritt 5: `src/codex.ts` und `src/checks.ts` migrieren

Direkte `spawn()`-Aufrufe und `env: process.env` werden entfernt. Der bestehende
Argumentbau bleibt zunächst unverändert.

- [ ] Schritt 6: Verifizieren

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="secret|SIGTERM|redaction|process" tests/*.test.mjs`

Erwartet: alle neuen Security-Tests erfolgreich.

- [ ] Schritt 7: Commit

```bash
git add src/runtime src/codex.ts src/checks.ts tests/security-boundaries.test.mjs
git commit -m "fix: isolate child processes and redact persisted output"
```

## Task 5: Extra-Konfiguration auf Allowlist umstellen

Dateien:

- Ändern: `src/codex.ts`
- Ändern: `src/server.ts`
- Ändern: `tests/config-agents.test.mjs`

- [ ] Schritt 1: Tests auf Ablehnung unbekannter Keys ändern

```js
for (const key of ["mcp_servers.evil.command", "future_unknown_key", "hooks.on_start"]) {
    assert.throws(() => validateExtraConfig({ [key]: "x" }), /nicht erlaubt/);
}
```

- [ ] Schritt 2: Kleine Allowlist implementieren

```ts
const ALLOWED_EXTRA_CONFIG = new Set([
    "model_verbosity",
    "model_reasoning_summary",
    "hide_agent_reasoning",
]);
```

Keys werden normalisiert, Werte über feldspezifische Zod-Schemas validiert und
unbekannte Keys als Toolfehler zurückgegeben. Es gibt kein stilles Dropping.

- [ ] Schritt 3: Toolbeschreibung und README-Verhalten angleichen

`task_start` dokumentiert die erlaubten Keys explizit. Die Bezeichnung
`fail-closed` bleibt erst nach dieser Umstellung bestehen.

- [ ] Schritt 4: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="extra_config|BlockedConfig" tests/*.test.mjs`

```bash
git add src/codex.ts src/server.ts tests/config-agents.test.mjs
git commit -m "fix: allowlist per-task Codex configuration"
```

## Task 6: ExecutionTarget-Vertrag und lokales Target einführen

Dateien:

- Erstellen: `src/execution/types.ts`
- Erstellen: `src/execution/errors.ts`
- Erstellen: `src/execution/local-target.ts`
- Erstellen: `tests/local-target.test.mjs`
- Ändern: `src/codex.ts`

- [ ] Schritt 1: Contract-Tests mit Fake-Target schreiben

Der Test prüft Codex-Stream, Checkresultat, Git-Identity, Abort und stabile
Fehlercodes.

- [ ] Schritt 2: Typen definieren

```ts
/** @typedef TargetErrorCode */
export type TargetErrorCode =
    | "TARGET_CONNECTIVITY"
    | "TARGET_HOST_KEY"
    | "TARGET_AUTH"
    | "TARGET_POLICY"
    | "TARGET_VERSION"
    | "TARGET_PROTOCOL"
    | "TARGET_REPOSITORY"
    | "TARGET_CANCELLED"
    | "TARGET_TIMEOUT";

/** @typedef ExecutionTarget */
export interface ExecutionTarget {
    readonly id: string;
    readonly kind: "local" | "ssh";
    doctor(request: DoctorRequest): Promise<TargetHealth>;
    resolveRepository(mapping: RepositoryMapping): Promise<RepositoryIdentity>;
    startCodex(request: CodexRunRequest): RunningCommand;
    runCheck(request: CheckRequest): Promise<CommandResult>;
    runGit(request: GitRequest): Promise<CommandResult>;
}
```

- [ ] Schritt 3: `TargetError` implementieren

Die Klasse trägt Code, retryable, targetId und redigierte Details. Ursache und
stderr werden nicht automatisch serialisiert.

- [ ] Schritt 4: Bestehendes Verhalten in `LocalExecutionTarget` verschieben

Das lokale Target nutzt ausschließlich `runManagedProcess()` und die validierte
Config. `src/codex.ts` exportiert weiterhin `buildCodexArgs()`, aber startet
keinen Prozess mehr direkt.

- [ ] Schritt 5: Parität verifizieren

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="local target|buildCodexArgs" tests/*.test.mjs`

Erwartet: bestehende Argumenttests und neue Target-Tests erfolgreich.

- [ ] Schritt 6: Commit

```bash
git add src/execution src/codex.ts tests/local-target.test.mjs
git commit -m "refactor: introduce execution target boundary"
```

## Task 7: SQLite-Migrationen und Target-Provenienz ergänzen

Dateien:

- Erstellen: `src/db/migrations.ts`
- Ändern: `src/db.ts`
- Ändern: `src/types.ts`
- Erstellen: `tests/migrations.test.mjs`

- [ ] Schritt 1: Migrationstest von bestehendem Schema schreiben

Der Test erzeugt eine v1-Datenbank mit einem Task, öffnet sie mit dem neuen
Store und erwartet `target_id=local`, `target_kind=local` und unveränderte
Bestandsdaten.

- [ ] Schritt 2: Versionierte Migration implementieren

```ts
const MIGRATIONS: ReadonlyArray<Migration> = [
    {
        version: 2,
        statements: [
            "ALTER TABLE tasks ADD COLUMN target_id TEXT NOT NULL DEFAULT 'local'",
            "ALTER TABLE tasks ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'local'",
            "ALTER TABLE tasks ADD COLUMN repository_commit TEXT",
            "ALTER TABLE tasks ADD COLUMN worker_version TEXT",
            "ALTER TABLE tasks ADD COLUMN routing_reason TEXT",
            "ALTER TABLE tasks ADD COLUMN fallback_from TEXT"
        ]
    }
];
```

Jede Migration läuft in `BEGIN IMMEDIATE`/`COMMIT`; Fehler führen zu `ROLLBACK`.
Danach wird `PRAGMA user_version` gesetzt.

- [ ] Schritt 3: Store-Verzeichnis und Dateien härten

Beim Anlegen wird das Verzeichnis auf `0700` und die DB auf `0600` gesetzt,
soweit das Betriebssystem POSIX-Modi unterstützt. Fehler werden als Doctor-
Warnung, nicht als Secretinhalt, ausgegeben.

- [ ] Schritt 4: Rows strikt typisieren

Die verbliebenen Runtime-`any`-Rückgaben für Reviews, Checks und Hypothesen
werden durch konkrete Interfaces ersetzt. `updateTask()` akzeptiert nur eine
statische Spaltenmap statt dynamischer Feldnamen.

- [ ] Schritt 5: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="migration|Store" tests/*.test.mjs`

```bash
git add src/db.ts src/db src/types.ts tests/migrations.test.mjs
git commit -m "feat: persist execution target provenance with migrations"
```

## Task 8: SSH-Protokoll und Fake-Transport implementieren

Dateien:

- Erstellen: `src/execution/ssh/protocol.ts`
- Erstellen: `src/execution/ssh/client.ts`
- Erstellen: `tests/ssh-protocol.test.mjs`
- Erstellen: `tests/fixtures/fake-ssh.mjs`

- [ ] Schritt 1: Protokolltests schreiben

Abgedeckt werden gültige Frames, unbekannte Operationen, zu große Frames,
zusätzliche Felder, Traversalpfade und Worker-Versionsabweichung.

- [ ] Schritt 2: Strikte Frame-Schemas implementieren

```ts
export const WorkerRequestSchema = z.discriminatedUnion("operation", [
    z.object({ requestId: z.string().uuid(), operation: z.literal("handshake"), protocol: z.literal(1) }).strict(),
    z.object({ requestId: z.string().uuid(), operation: z.literal("doctor") }).strict(),
    CodexRunRequestSchema,
    CheckRunRequestSchema,
    GitRequestSchema,
    AuthStatusRequestSchema,
    AuthBootstrapRequestSchema,
]);
```

- [ ] Schritt 3: SSH-Client ohne Shellstrings implementieren

OpenSSH wird mit argv gestartet. Host muss ein validierter Alias sein.
Verwendete Optionen:

```ts
const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    host,
    "node",
    remoteWorkerEntry,
];
```

Der Remote-Einstiegspfad wird aus einer validierten, vom Deployer erzeugten
Version referenziert; Nutzerinput wird nicht als Remote-Kommando eingesetzt.

- [ ] Schritt 4: SSH-Fehler klassifizieren

Exit 255 plus bekannte Transporttexte wird `TARGET_CONNECTIVITY`.
Host-Key-Fehler wird `TARGET_HOST_KEY` und nie retryable. Alle Texte werden vor
Persistenz redigiert.

- [ ] Schritt 5: Fake-SSH-Tests ausführen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="SSH|protocol|frame" tests/*.test.mjs`

- [ ] Schritt 6: Commit

```bash
git add src/execution/ssh tests/ssh-protocol.test.mjs tests/fixtures/fake-ssh.mjs
git commit -m "feat: add validated SSH worker protocol"
```

## Task 9: Begrenzten Remote-Worker bauen

Dateien:

- Erstellen: `src/worker/server.ts`
- Erstellen: `src/worker/operations.ts`
- Erstellen: `src/worker/path-policy.ts`
- Erstellen: `tests/worker.test.mjs`
- Ändern: `package.json`

- [ ] Schritt 1: Worker-Sandboxtests schreiben

Der Worker verweigert unbekannte Operationen, `..`-Traversal, Symlink-Escape,
unzulässige Git-Subcommands, freie Checks und Worker-Roots außerhalb der
Konfiguration.

- [ ] Schritt 2: Worker-Handshake implementieren

Antwort enthält Protokollversion, Buildversion, Plattform, Node- und Codex-
Version, aber keine Umgebungsvariablen oder absoluten Home-Pfade.

- [ ] Schritt 3: Operation-Allowlist implementieren

Git wird als festes Mapping aufgebaut, beispielsweise:

```ts
const GIT_OPERATIONS = {
    identity: ["rev-parse", "--show-toplevel", "HEAD"],
    status: ["status", "--porcelain=v1"],
    diffNumstat: ["--no-pager", "diff", "--numstat", "HEAD"],
} as const;
```

Worktree-Operationen haben eigene Schemas und validierte Branch-/Pfadwerte.

- [ ] Schritt 4: Codex-Streaming implementieren

Der Worker nutzt denselben sicheren Prozess-Runner, streamt validierte JSONL-
Events und beendet den Kindprozess bei stdin-/SSH-Abbruch, Timeout oder Signal.

- [ ] Schritt 5: Worker-Bundle erstellen und testen

Ausführen:
`npm run bundle:worker && npm run typecheck && npm run build && node --test --test-name-pattern=worker tests/*.test.mjs`

Erwartet: Bundle vorhanden, alle Worker-Tests erfolgreich.

- [ ] Schritt 6: Commit

```bash
git add src/worker tests/worker.test.mjs package.json bundle/worker.mjs
git commit -m "feat: add constrained remote execution worker"
```

## Task 10: Contentadressiertes Worker-Deployment ergänzen

Dateien:

- Erstellen: `src/execution/ssh/deploy.ts`
- Erstellen: `tests/ssh-deploy.test.mjs`
- Ändern: `src/execution/ssh/target.ts`

- [ ] Schritt 1: Deploymenttests schreiben

Ein Fake-SFTP-Prozess prüft: Hashvergleich, Upload in temporären Pfad, Modus
`0700`, atomare Umbenennung, Wiederverwendung identischer Versionen und
Aufräumen nach Fehlern.

- [ ] Schritt 2: SHA-256 des Worker-Bundles berechnen

Der Zielpfad lautet
`<workerRoot>/<pluginVersion>/<sha256>/worker.mjs`. Der Hash ist
Integritätsbeleg, kein Authentifizierungsmechanismus.

- [ ] Schritt 3: Batch-SFTP verwenden

Der Deployer startet `sftp -b - <host>` mit Batchbefehlen. Host und Zielpfade
sind bereits validiert. Es gibt keine Optionen, Host-Key-Prüfung abzuschalten.

- [ ] Schritt 4: Handshake nach Deployment erzwingen

Eine nicht passende Protokoll- oder Buildversion erzeugt `TARGET_VERSION` und
keinen Local-Fallback.

- [ ] Schritt 5: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="deploy|handshake" tests/*.test.mjs`

```bash
git add src/execution/ssh/deploy.ts src/execution/ssh/target.ts tests/ssh-deploy.test.mjs
git commit -m "feat: deploy versioned remote worker atomically"
```

## Task 11: Sicheren Auth-Status und Bootstrap implementieren

Dateien:

- Erstellen: `src/auth/status.ts`
- Erstellen: `src/auth/bootstrap.ts`
- Ändern: `src/worker/operations.ts`
- Erstellen: `tests/auth-bootstrap.test.mjs`

- [ ] Schritt 1: Tests ausschließlich mit synthetischen Credentials schreiben

Fixtures enthalten zufällige Bytefolgen und Canary-Strings, aber keine reale
`auth.json`. Tests prüfen `0600`, atomare Ablage, maximale Dateigröße,
Eigentümerprüfung, keine Logausgabe und kein Überschreiben einer gesunden
Remote-Anmeldung.

- [ ] Schritt 2: Authstatus über CLI ermitteln

`codex login status` und optional `codex doctor --json` werden mit Timeout,
minimalem Environment und redigierter Ausgabe ausgeführt. Ergebnis ist nur:

```ts
export interface AuthStatus {
    state: "authenticated" | "unauthenticated" | "unavailable" | "error";
    method?: "chatgpt" | "api-key" | "access-token" | "unknown";
    message: string;
}
```

- [ ] Schritt 3: Lokale Dateiquelle validieren

`lstat()` muss reguläre Datei, aktueller Eigentümer, keine Gruppen-/Weltrechte
und maximal 64 KiB ergeben. Symlinks werden abgelehnt. Der Inhalt wird nicht als
JSON geparst.

- [ ] Schritt 4: Remote atomar schreiben

Der Worker liest exakt die angekündigte Bytezahl, schreibt mit Flag `wx` und
Modus `0600`, führt `fsync()` aus und benennt atomar nach
`$CODEX_HOME/auth.json` um. Bestehende gesunde Credentials werden nicht
überschrieben.

- [ ] Schritt 5: Access-Token-Strategie implementieren

`secretCommand` wird lokal als argv ohne Shell ausgeführt. stdout fließt direkt
über eine Pipe in den Remote-Worker und dort in
`codex login --with-access-token`. Der Token wird nicht als String im Store
gehalten und nicht in Events aufgenommen.

- [ ] Schritt 6: Device-Auth als deterministischen Blocker ausgeben

Wenn keine automatisierbare Strategie existiert, liefert Doctor die konkrete
Empfehlung `codex login --device-auth` auf dem Remote-Host und begründet die
einmalige Interaktion mit OAuth/MFA/SSO. Der Server versucht keinen Bypass.

- [ ] Schritt 7: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern=auth tests/*.test.mjs`

Zusatzprüfung: `rg -n "canary-secret" .orchestrator tests/tmp` muss leer sein.

```bash
git add src/auth src/worker/operations.ts tests/auth-bootstrap.test.mjs
git commit -m "feat: bootstrap remote Codex auth without exposing credentials"
```

## Task 12: Target-Router und connectivity-only Fallback implementieren

Dateien:

- Erstellen: `src/execution/router.ts`
- Erstellen: `tests/router.test.mjs`
- Ändern: `src/session.ts`
- Ändern: `src/db.ts`

- [ ] Schritt 1: Routing-Matrix als table-driven Tests schreiben

```js
const cases = [
    ["healthy remote", "remote", null],
    ["SSH timeout", "local", "TARGET_CONNECTIVITY"],
    ["host key mismatch", "blocked", "TARGET_HOST_KEY"],
    ["remote auth missing", "blocked", "TARGET_AUTH"],
    ["worker mismatch", "blocked", "TARGET_VERSION"],
    ["commit mismatch", "blocked", "TARGET_REPOSITORY"],
];
```

- [ ] Schritt 2: Router implementieren

Die Targetwahl erfolgt vor `createTask()`. Remote-Preflight hat höchstens zwei
Versuche mit begrenztem exponentiellem Backoff und Jitter. Nur ein
`TARGET_CONNECTIVITY` mit `retryable=true` darf Local-Preflight auslösen.

- [ ] Schritt 3: Repository-Identität erzwingen

Remote und lokal liefern `topLevel`, `headCommit`, `isClean` und
`worktreeIdentity`. Fallback erfordert denselben aufgezeichneten Commit und
sauberen Zustand. Andernfalls entsteht `TARGET_REPOSITORY`.

- [ ] Schritt 4: Target unveränderlich am Task speichern

`SessionManager` löst bei Resume ausschließlich `task.target_id` auf. Er ruft
den Router nicht erneut auf. Ein nicht verfügbares gepinntes Target blockiert
den Task mit klarer Fortsetzungsentscheidung.

- [ ] Schritt 5: Routingevents persistieren

`target_selected` und `target_fallback` enthalten nur Target-ID, Fehlercode,
Dauer und Repository-Commit. Sie enthalten keine SSH-Ausgabe oder Secrets.

- [ ] Schritt 6: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="router|fallback|pinned" tests/*.test.mjs`

```bash
git add src/execution/router.ts src/session.ts src/db.ts tests/router.test.mjs
git commit -m "feat: route new tasks remote first with safe local fallback"
```

## Task 13: Checks, Diffs und Worktrees targetfähig machen

Dateien:

- Ändern: `src/checks.ts`
- Ändern: `src/worktree.ts`
- Ändern: `src/resolve.ts`
- Ändern: `src/server.ts`
- Erstellen: `tests/target-repository.test.mjs`

- [ ] Schritt 1: Remote-Repository-Integrationstest schreiben

Ein In-Process-Worker arbeitet auf einem temporären Git-Repository. Testfolge:
Identity, Worktree anlegen, Datei ändern, Diffgröße ermitteln, Check ausführen,
Reviewstatus setzen, Merge und Cleanup.

- [ ] Schritt 2: Checks als logische Operationen modellieren

Die Config enthält weiterhin benannte Checks. Das Target erhält nur die bereits
serverseitig erlaubte `CheckSpec`; ein Tool kann weder argv noch Binärdatei
liefern.

- [ ] Schritt 3: WorktreeManager auf Target umstellen

Alle Gitoperationen verwenden `target.runGit()`. Remote-Pfade werden nur vom
Remote-Worker erzeugt und als opaque Referenz im Store gespeichert.

- [ ] Schritt 4: Diffgrenzen auf demselben Target prüfen

`task_result`, `repo_check` und Review verwenden stets das Target des Tasks bzw.
Clusters. Mischungen aus lokalem Check und Remote-Diff sind unzulässig.

- [ ] Schritt 5: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="target repository|worktree|diff" tests/*.test.mjs`

```bash
git add src/checks.ts src/worktree.ts src/resolve.ts src/server.ts tests/target-repository.test.mjs
git commit -m "refactor: execute repository operations on the selected target"
```

## Task 14: Integrity-Gates und read-only-Verhalten reparieren

Dateien:

- Ändern: `src/agents.ts`
- Ändern: `src/session.ts`
- Ändern: `src/statemachine.ts`
- Ändern: `src/server.ts`
- Ändern: `tests/security-boundaries.test.mjs`
- Ändern: `tests/statemachine.test.mjs`

- [ ] Schritt 1: AGENTS-Dateimutation entfernen

`ensureAgentsMd()` wird aus `SessionManager` entfernt. Die Executor-Vorlage wird
als Promptabschnitt geliefert. Existierende Projekt-`AGENTS.md` bleiben allein
Eigentum von Codex und dem Repository.

- [ ] Schritt 2: Read-only-Test grün machen

Ausführen:
`npm run build && node --test --test-name-pattern="read-only" tests/*.test.mjs`

Erwartet: Repositoryinhalt und Gitstatus unverändert.

- [ ] Schritt 3: Merge-Prädikat zentralisieren

```ts
export function mergeEligibility(input: MergeEligibilityInput): Eligibility {
    const reasons: string[] = [];
    if (input.clusterStatus !== "confirmed") reasons.push("cluster_not_confirmed");
    if (input.reviewStatus !== "confirmed") reasons.push("review_not_confirmed");
    if (!input.checksGreen) reasons.push("checks_not_green");
    if (input.taskClusterId !== input.clusterId) reasons.push("task_cluster_mismatch");
    if (!TERMINAL_TASK_STATUSES.has(input.taskStatus)) reasons.push("task_not_terminal");
    return { ok: reasons.length === 0, reasons };
}
```

- [ ] Schritt 4: Reviewstatus runtime-validieren

Nur `confirmed` und `needs_changes` sind zulässige Reviewresultate. Arbiträre
Strings aus `payload.status` werden nicht mehr gespeichert.

- [ ] Schritt 5: Check-Zeitbezug sichern

Ein Confirm akzeptiert nur Checks, die nach der letzten Submission und für den
aktuellen Repository-Commit ausgeführt wurden. Checkrows erhalten
`repository_commit` und `task_id`.

- [ ] Schritt 6: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="merge|confirm|read-only" tests/*.test.mjs`

```bash
git add src/agents.ts src/session.ts src/statemachine.ts src/server.ts tests
git commit -m "fix: enforce immutable read-only runs and merge gates"
```

## Task 15: Doctor und dynamischen Modellkatalog ergänzen

Dateien:

- Erstellen: `src/doctor.ts`
- Erstellen: `src/model-catalog.ts`
- Erstellen: `src/tools/doctor.ts`
- Erstellen: `tests/doctor.test.mjs`
- Ändern: `src/server.ts`

- [ ] Schritt 1: Redigierte Doctor-Fixtures schreiben

Tests decken lokale Gesundheit, Remote-Gesundheit, Connectivity-Fallback,
fehlende Remote-Auth, Host-Key-Fehler, Commitabweichung und externe
Connector-Unbeobachtbarkeit ab.

- [ ] Schritt 2: Codex-Diagnose integrieren

`codex doctor --json` wird mit minimalem Environment und Timeout ausgeführt.
Nur schema-validierte, redigierte Felder werden übernommen.

- [ ] Schritt 3: Modellkatalog dynamisch lesen

`codex debug models --bundled` wird pro Target gecacht. Das Parser-Schema liest
`slug`, `display_name`, `default_reasoning_level` und
`supported_reasoning_levels[].effort`. Bei Fehlern werden konservative Config-
Defaults mit `source=fallback` gemeldet.

- [ ] Schritt 4: MCP-Tool registrieren

`orchestrator_doctor` akzeptiert `scope=local|remote|all` und
`include_paths=false` als Standard. Es verändert weder Auth noch Konfiguration.

- [ ] Schritt 5: GitHub-Connector sauber abgrenzen

Doctor liefert:

```json
{
  "external_connectors": {
    "github": {
      "state": "not_observable",
      "owner": "claude_host",
      "note": "Nicht Teil des Codex-Executor-Transports"
    }
  }
}
```

- [ ] Schritt 6: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern="doctor|model catalog" tests/*.test.mjs`

```bash
git add src/doctor.ts src/model-catalog.ts src/tools/doctor.ts src/server.ts tests/doctor.test.mjs
git commit -m "feat: add redacted orchestrator diagnostics"
```

## Task 16: Server und Session nach Verantwortlichkeiten zerlegen

Dateien:

- Erstellen: `src/tools/task-tools.ts`
- Erstellen: `src/tools/cluster-tools.ts`
- Erstellen: `src/tools/repository-tools.ts`
- Erstellen: `src/tools/maintenance-tools.ts`
- Erstellen: `src/server-context.ts`
- Ändern: `src/server.ts`
- Ändern: `src/session.ts`
- Erstellen: `src/session/control.ts`
- Erstellen: `src/session/slice-loop.ts`

- [ ] Schritt 1: Toolinventar als Contract-Test schreiben

Der Test erwartet exakt die veröffentlichten Toolnamen einschließlich
`orchestrator_doctor` und vergleicht JSON-Schemas gegen Snapshots.

- [ ] Schritt 2: Composition Root definieren

```ts
export interface ServerContext {
    store: Store;
    sessions: SessionManager;
    machine: ClusterStateMachine;
    targets: ExecutionTargetRegistry;
    router: ExecutionTargetRouter;
}
```

- [ ] Schritt 3: Tools ohne Verhaltensänderung verschieben

Jede Datei registriert eine kohärente Toolgruppe. `src/server.ts` erstellt
Kontext, registriert Gruppen, verbindet stdio und verwaltet Shutdown.

- [ ] Schritt 4: Session-Lifecycle trennen

Control-State, Wartelogik und Slice-Loop werden getrennte, injizierbare Module.
Store und Target werden als Interfaces injiziert, nicht global importiert.

- [ ] Schritt 5: Keine Runtime-`any` verbleiben lassen

Zod-inferierte Payloads und konkrete DB-Row-Typen ersetzen `any`. Erlaubte
Ausnahmen benötigen Kommentar mit Eingrenzung und Test.

- [ ] Schritt 6: Verifizieren und committen

Ausführen: `npm run typecheck && npm test`

Erwartet: vollständige Verhaltensparität und grünes Toolinventar.

```bash
git add src/server.ts src/server-context.ts src/tools src/session.ts src/session
git commit -m "refactor: separate MCP tools from execution lifecycle"
```

## Task 17: Selbstupdate entfernen und Update-Ownership klären

Dateien:

- Ändern: `src/server.ts`
- Ändern: `src/plugin.ts`
- Ändern: `src/updater.ts`
- Ändern: `src/tools/maintenance-tools.ts`
- Ändern: `tests/plugin.test.mjs`

- [ ] Schritt 1: Test schreiben, dass Serverstart keine Netz-/Installaktion auslöst

Fake-`fetch`, Fake-`npm` und Fake-`git` müssen beim Start unangetastet bleiben.

- [ ] Schritt 2: Startup-Aufrufe entfernen

`maybeAutoUpdate()` und `maybePluginUpdate()` werden nicht mehr beim MCP-Start
aufgerufen.

- [ ] Schritt 3: Mutierende Update-Tools entfernen oder hart opt-in machen

Für die offizielle Distribution wird `plugin_update apply` entfernt. Der
Doctor verweist auf `claude plugin update`. `codex_update apply` ist standardmäßig
deaktiviert und nur mit `ORCH_ALLOW_CODEX_UPDATE=true` sowie explizitem
Toolparameter `confirm=true` erreichbar.

- [ ] Schritt 4: Verifizieren und committen

Ausführen:
`npm run typecheck && npm run build && node --test --test-name-pattern=update tests/*.test.mjs`

```bash
git add src/server.ts src/plugin.ts src/updater.ts src/tools/maintenance-tools.ts tests/plugin.test.mjs
git commit -m "fix: assign update ownership to managed installers"
```

## Task 18: Lint, Format und Coverage-Gates einführen

Dateien:

- Ändern: `package.json`
- Ändern: `package-lock.json`
- Erstellen: `eslint.config.js`
- Erstellen: `.prettierrc.json`
- Erstellen: `scripts/check-coverage.mjs`
- Ändern: `.github/workflows/ci.yml`

- [ ] Schritt 1: Toolchain installieren

Ausführen:
`npm install --save-dev eslint @eslint/js typescript-eslint prettier`

- [ ] Schritt 2: Strikte Regeln konfigurieren

Aktiviert werden mindestens `no-explicit-any`, ungefangene Promises,
exhaustive Switches, keine unbenutzten Variablen und konsistente Type-Imports.
Generated Bundles sind ausgeschlossen.

- [ ] Schritt 3: Skripte ergänzen

```json
{
  "scripts": {
    "lint": "eslint src tests scripts",
    "format:check": "prettier --check src tests scripts docs package.json .claude-plugin",
    "ci": "npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:coverage && npm run bundle && npm run bundle:worker && npm run verify:bundle"
  }
}
```

- [ ] Schritt 4: Coverage-Gates implementieren

Global mindestens 85 Prozent Lines und 80 Prozent Branches. Für Router,
Auth-Bootstrap, Worker-Protokoll, Environment und Merge-Gate müssen alle
Entscheidungszweige abgedeckt sein.

- [ ] Schritt 5: CI minimal berechtigen und pinnen

Workflow ergänzt `permissions: contents: read`, `timeout-minutes`, npm cache,
strikte Pluginvalidierung und vollständige Commit-SHAs für Actions.

- [ ] Schritt 6: Verifizieren und committen

Ausführen: `npm run ci && claude plugin validate --strict .`

```bash
git add package.json package-lock.json eslint.config.js .prettierrc.json scripts/check-coverage.mjs .github/workflows/ci.yml
git commit -m "ci: enforce lint coverage and reproducible bundles"
```

## Task 19: Claude-Plugin-Metadaten und Releaseversionen normalisieren

Dateien:

- Ändern: `.claude-plugin/marketplace.json`
- Ändern: `.claude-plugin/plugin.json`
- Ändern: `package.json`
- Ändern: `package-lock.json`
- Erstellen: `scripts/verify-release-metadata.mjs`
- Erstellen: `.npmignore`

- [ ] Schritt 1: Strikte Manifestwarnung beheben

Marketplace-Wurzel erhält eine präzise `description`. Pluginbeschreibung nennt
Remote-Ausführung nur, wenn die Implementierung vollständig vorhanden ist.

- [ ] Schritt 2: Eine Versionquelle durchsetzen

`scripts/verify-release-metadata.mjs` vergleicht Paket, Lockfile,
Pluginmanifest, Worker-Handshake und MCP-Serverversion.

- [ ] Schritt 3: MCP-Version aus Paketmetadaten injizieren

Die hartkodierte `0.3.0` entfällt. Der Build injiziert
`ORCHESTRATOR_VERSION`, das Server und Worker gemeinsam verwenden.

- [ ] Schritt 4: npm-Paketoberfläche begrenzen

`.npmignore` oder vorzugsweise `package.json.files` enthält nur `dist`,
`bundle`, `templates`, `README.md`, `LICENSE` und notwendige Manifeste. Vor der
Entscheidung wird festgelegt, ob npm weiterhin unterstützter Vertriebskanal ist.

- [ ] Schritt 5: Verifizieren

Ausführen:

```bash
node scripts/verify-release-metadata.mjs
claude plugin validate --strict .
claude plugin tag --dry-run .
npm pack --dry-run --json
```

Erwartet: keine Warnung; Tag `codex-orchestrator--v<version>`; Paket enthält
keine Tests, CI-Dateien oder lokale Zustände.

- [ ] Schritt 6: Commit

```bash
git add .claude-plugin package.json package-lock.json scripts/verify-release-metadata.mjs .npmignore
git commit -m "chore: align Claude plugin release metadata"
```

## Task 20: README, Skill und Betriebsdokumentation synchronisieren

Dateien:

- Ändern: `README.md`
- Ändern: `skills/codex-orchestrator/SKILL.md`
- Erstellen: `docs/remote-execution.md`
- Erstellen: `docs/authentication.md`
- Erstellen: `docs/operations.md`
- Erstellen: `SECURITY.md`
- Erstellen: `CONTRIBUTING.md`
- Erstellen: `CHANGELOG.md`

- [ ] Schritt 1: README-Zielbild aktualisieren

Dokumentiert werden lokale Standardausführung, Remote-opt-in,
connectivity-only Fallback, Target-Pinning, Authstrategien, Doctor und die klare
Abgrenzung zum GitHub-Connector.

- [ ] Schritt 2: Authentifizierungsdokument schreiben

Enthält die Rangfolge `existing`, Device-Auth, Access Token,
`sync-file`; Dateirechte, Trusted-Host-Voraussetzung, Rotation, Revocation und
das Verbot, `auth.json` in Chat, Tickets oder Git zu übertragen.

- [ ] Schritt 3: Skill-Workflow aktualisieren

Vor `task_start` ruft Claude einmal `orchestrator_doctor` auf. Bei externem
Connector-Ratelimit erfolgt höchstens ein begrenzter Retry; Connectorfehler
werden nicht als Codex-Authfehler beschrieben. Target und Fallbackgrund werden
in jeder Taskzusammenfassung genannt.

Der vorhandene Skill bleibt die einzige Command-Quelle und erhält:

```yaml
---
name: codex-orchestrator
description: Orchestrate a coding task through supervised Codex execution
argument-hint: <Auftrag>
---
```

Der Body verwendet `$ARGUMENTS` als initiales Ziel. Ist es leer, fordert Claude
genau eine konkrete Aufgabenbeschreibung an. Bei vorhandenem Argument startet
der Doctor- und Planungsablauf ohne weitere Aktivierungsfrage.

- [ ] Schritt 4: Security- und Supportpolicy dokumentieren

`SECURITY.md` definiert Meldeweg, unterstützte Versionen, Credential-
Incident-Response und Rotation. `CONTRIBUTING.md` enthält lokale CI-,
Bundle- und Pluginvalidierungsbefehle.

- [ ] Schritt 5: Slash-Command und Dokumentationskonsistenz testen

Ein Test extrahiert Toolnamen und Envvariablen aus Runtime und vergleicht sie
mit README/Skill. Veraltete Namen lassen CI scheitern.

Zusätzlich wird ein gepacktes Testplugin mit `claude plugin validate --strict`
geprüft. Der Skill muss `name: codex-orchestrator`, `argument-hint`,
`$ARGUMENTS` und den Aufruf von `orchestrator_doctor` enthalten. Ein
`commands/codex-orchestrator.md` darf nicht parallel existieren.

- [ ] Schritt 6: Verifizieren und committen

Ausführen:
`npm run ci && claude plugin validate --strict . && rg -n "0\.3\.0|83 Tests|auto-update" README.md skills docs`

Erwartet: keine veralteten Behauptungen.

```bash
git add README.md skills docs SECURITY.md CONTRIBUTING.md CHANGELOG.md tests
git commit -m "docs: document secure remote orchestration operations"
```

## Task 21: Release-E2E und Marketplace-Einreichung vorbereiten

Dateien:

- Erstellen: `scripts/release-smoke.mjs`
- Erstellen: `docs/release-checklist.md`
- Erstellen: `.github/workflows/release.yml`
- Ändern: `.github/workflows/ci.yml`

- [ ] Schritt 1: Gepackten Plugin-Smoke-Test schreiben

Der Test kopiert nur veröffentlichte Dateien in ein temporäres Verzeichnis,
startet den MCP-Server daraus, ruft `orchestrator_doctor`, `models_list` und
einen lokalen read-only Fake-Slice auf und beendet sauber.

- [ ] Schritt 2: Remote-E2E hinter geschütztem Environment ergänzen

Der Workflow läuft nur manuell oder auf Release-Tags, nie für Fork-PRs. SSH-Key,
Host und synthetisches Testkonto kommen aus einem geschützten Environment. Kein
persönlicher `auth.json`-Cache wird in CI verwendet.

- [ ] Schritt 3: Releaseworkflow implementieren

Gates: `npm ci`, vollständige CI, strikte Pluginvalidierung, Metadatenprüfung,
deterministische Bundles, SBOM, Checksummen, Release-Smoke und Tagformat
`codex-orchestrator--v<version>`.

- [ ] Schritt 4: Releasecheckliste schreiben

Sie verlangt Changelog, Securityreview, Credential-Canary-Test,
Backward-Compatibility-Test, Remote-/Fallback-Matrix, Artefaktchecksummen,
Supportkontakt und Rollback-Anweisung.

- [ ] Schritt 5: Gesamtabnahme ausführen

```bash
npm ci
npm run ci
claude plugin validate --strict .
node scripts/verify-release-metadata.mjs
node scripts/release-smoke.mjs
claude plugin tag --dry-run .
git diff --exit-code
```

Erwartet: alle Befehle erfolgreich und sauberer Arbeitsbaum nach Build.

- [ ] Schritt 6: Commit

```bash
git add scripts/release-smoke.mjs docs/release-checklist.md .github/workflows
git commit -m "ci: add submission-ready Claude plugin release gates"
```

## Task 22: Unabhängige finale Reviews und Einreichungsartefakt

Dateien:

- Erstellen: `docs/reviews/production-readiness.md`
- Erstellen: `docs/reviews/security-review.md`
- Erstellen: `docs/reviews/marketplace-submission.md`

- [ ] Schritt 1: Architekturreview ausführen

Prüffokus: Zustandsowner, Target-Pinning, Repository-Kohärenz, Fehlerklassen,
Migrationen und Backward Compatibility. Alle Findings werden vor Freigabe
geschlossen oder mit Owner und Frist dokumentiert.

- [ ] Schritt 2: Securityreview ausführen

Prüffokus: Credential-Lebenszyklus, Environment-Grenzen, SSH-Host-Key,
Remote-Pfade, Protokollparser, Outputredaktion, Update-Lieferkette und
Repository-Codeausführung.

- [ ] Schritt 3: Marketplace-Review ausführen

Prüffokus: Claude-Plugin-Struktur, Installationsweg, Skill-Trigger,
Toolbeschreibungen, Tokenkosten, Datenschutz, Support und Deinstallation.

- [ ] Schritt 4: Einreichungsartefakt erstellen

Das Dokument enthält Produktbeschreibung, Zielgruppe, Berechtigungen,
Netzwerk-/Credential-Verhalten, Installations- und Uninstallationspfad,
Testmatrix, Securitykontakt, Release-URL und Checksummen.

- [ ] Schritt 5: Finales Gate

Es darf keine offene P0/P1-Feststellung geben. P2-Feststellungen benötigen
expliziten Owner, Risikoakzeptanz und Zielversion. Erst danach wird ein Release-
Tag erstellt und der externe Marketplace-Prozess gestartet.

- [ ] Schritt 6: Commit

```bash
git add docs/reviews
git commit -m "docs: record production and marketplace readiness"
```

## Reihenfolge und Release-Schnitte

Release-Schnitt A, Sicherheitsbaseline:
Tasks 1 bis 7 und 14. Kein Remote-Feature, aber die dokumentierten
Sicherheitsversprechen sind technisch belastbar.

Release-Schnitt B, Remote Preview:
Tasks 8 bis 15. Remote nur opt-in; keine offizielle Einreichung vor E2E-
Nachweis.

Release-Schnitt C, Marketplace Candidate:
Tasks 16 bis 22. Erst dieser Stand ist für die offizielle Einreichung vorgesehen.

## Plan-Selbstprüfung

- Alle 15 Akzeptanzkriterien des Designs sind einem oder mehreren Tasks
  zugeordnet.
- Auth-Cache wird nur unverändert übertragen und nie geparst oder ausgegeben.
- Local-Fallback ist auf neue Tasks und Connectivity-Fehler begrenzt.
- GitHub-Connector-Probleme sind explizit außerhalb des Executor-Transports.
- Bestehende lokale Nutzung bleibt der Standard.
- Runtime-, Worker-, Plugin- und Releaseversion werden vereinheitlicht.
- Keine Aufgabe setzt eine freie Remote-Shell oder Klartextsecrets voraus.
- Die offizielle Marketplace-Annahme wird nicht als automatisierbares
  Akzeptanzkriterium dargestellt; Einreichungsreife und Nachweise schon.
