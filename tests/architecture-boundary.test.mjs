import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { systemClock, systemIdGenerator, nowIso, newId } from "../dist/system-clock.js";
import { extractImports } from "./helpers/imports.mjs";

/** Every production TypeScript file under src/, discovered — not hand-listed. */
function allSrcFiles(dir = "src") {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...allSrcFiles(p));
        else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
}

// Issue #32 (Cluster 1 + 3): the persistence boundary of the hexagonal refactor.
//
// `src/db.ts` (class Store) is the concrete SQLite adapter behind the
// `PersistenceStore` port (`src/ports/persistence.ts`). Domain/application
// modules depend on the port, never on the adapter or `node:sqlite`. This suite
// scans import specifiers — the same static technique as
// tests/execution-boundary.test.mjs — and fails if any layer's dependency
// direction rots. The layer membership is the single source of truth in
// ssot/architecture.json (see ssot/index.toml).

const manifest = JSON.parse(readFileSync("ssot/architecture.json", "utf8"));

/** Every import specifier a source module uses, in any form (see helpers/imports.mjs). */
function importsOf(srcPath) {
    return extractImports(readFileSync(srcPath, "utf8"));
}

/** Turn a forbidden module name into a specifier matcher (bare or ./path form). */
function forbids(spec, name) {
    if (spec === name) return true; // bare specifier, e.g. "node:sqlite"
    return new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.js)?$`).test(spec);
}

test("the manifest is internally consistent", () => {
    assert.ok(Array.isArray(manifest.corePortConsumers), "corePortConsumers must be an explicit list");
    assert.equal(manifest.adapters.persistence, "src/db.ts");
    assert.equal(manifest.ports.persistence, "src/ports/persistence.ts");
    assert.equal(manifest.ports.execution, "src/execution/types.ts");
    assert.ok(manifest.persistenceConsumers.length >= 8);
    for (const consumer of manifest.corePortConsumers) {
        assert.ok(
            manifest.persistenceConsumers.includes(consumer),
            `${consumer} is a core port consumer but not a persistence consumer`,
        );
    }
});

test("no persistence consumer imports the concrete adapter or node:sqlite", () => {
    for (const consumer of manifest.persistenceConsumers) {
        for (const spec of importsOf(consumer)) {
            assert.ok(
                !forbids(spec, "db"),
                `${consumer} must depend on the PersistenceStore port, not the adapter (${spec})`,
            );
            for (const forbidden of manifest.forbiddenPersistenceImports) {
                assert.ok(
                    !forbids(spec, forbidden),
                    `${consumer} must not import ${spec} (persistence is behind the port)`,
                );
            }
        }
    }
});

test("repo-wide: no un-allow-listed module imports the persistence adapter or node:sqlite", () => {
    // Completeness guard. The consumer-list tests above only prove that the
    // *known* members behave; they cannot catch a NEW file that reaches for the
    // adapter and was never added to a list. This test discovers every
    // src/**/*.ts and fails if any of them imports the persistence adapter
    // (src/db.ts) or node:sqlite unless it is on the explicit allow-list. A
    // barrel/re-export is caught too: re-exporting the adapter still requires
    // importing it, so the importing file shows up here.
    const allow = manifest.adapterImportAllowList;
    const violations = [];
    for (const file of allSrcFiles()) {
        const specs = importsOf(file);
        if (specs.some((s) => forbids(s, "db")) && !allow.persistenceAdapter.includes(file)) {
            violations.push(`${file} imports the persistence adapter (db.js) but is not in adapterImportAllowList.persistenceAdapter`);
        }
        if (specs.some((s) => forbids(s, "node:sqlite") || forbids(s, "sqlite")) && !allow.sqlite.includes(file)) {
            violations.push(`${file} imports node:sqlite but is not in adapterImportAllowList.sqlite`);
        }
    }
    assert.deepEqual(violations, [], `repo-wide boundary violations:\n${violations.join("\n")}`);
});

test("the repo-wide adapter guard actually goes red on an unlisted violating file", () => {
    // Meta-test: prove the guard above is not vacuous. A synthetic new module
    // that imports the adapter and is absent from the allow-list must be
    // detected by the same extractImports+forbids logic the guard uses.
    const synthetic = `import { Store } from "./db.js";\nawait import('node:sqlite');\nexport const x = 1;\n`;
    const specs = extractImports(synthetic);
    assert.ok(specs.some((s) => forbids(s, "db")), "the scanner must detect the adapter import");
    assert.ok(specs.some((s) => forbids(s, "node:sqlite")), "the scanner must detect the node:sqlite import");
    assert.ok(
        !manifest.adapterImportAllowList.persistenceAdapter.includes("src/synthetic-violation.ts"),
        "an unlisted file is not allow-listed -> the completeness guard records a violation for it",
    );
});

test("the manifest metadata matches the implemented composition-root state", () => {
    // Claim consistency: the SSOT's own prose must not contradict the delivered
    // state (the server split is done in this PR, not "a later cluster").
    assert.doesNotMatch(manifest.$comment, /later cluster/i, "$comment must not describe the server split as future work");
    for (const root of manifest.compositionRoots) assert.ok(existsSync(root), `composition root ${root} is missing`);
    assert.deepEqual(
        manifest.compositionRoots,
        ["src/server.ts", "src/app/context.ts"],
        "server.ts and app/context.ts are the application bootstrap composition roots",
    );
    assert.deepEqual(
        manifest.featureCompositionRoots,
        ["src/execution/registry.ts"],
        "execution/registry.ts is the execution feature composition root",
    );
    for (const root of manifest.featureCompositionRoots) {
        assert.ok(existsSync(root), `feature composition root ${root} is missing`);
    }
    assert.ok(existsSync(manifest.toolModulesDir), "toolModulesDir must exist");
});

test("docs/architecture.md classifies modules consistently with the manifest", () => {
    assert.ok(Array.isArray(manifest.corePortConsumers), "corePortConsumers must be an explicit list");
    const doc = readFileSync("docs/architecture.md", "utf8");
    const m = doc.match(/subgraph core\[[^\]]*\]([\s\S]*?)\n\s*end/);
    assert.ok(m, "the infrastructure-independent core services subgraph was not found in docs/architecture.md");
    const coreBlock = m[1];
    assert.doesNotMatch(coreBlock, /hypotheses/i, "hypotheses.ts is a repository/DAO, not a core service");
    for (const consumer of manifest.corePortConsumers) {
        const base = consumer.replace(/^src\//, "").replace(/\.ts$/, "");
        assert.match(coreBlock, new RegExp(base), `the core-services subgraph should mention ${base}`);
    }
});

test("maintainer docs state the established boundaries without overstating port coverage", () => {
    const architecture = readFileSync("docs/architecture.md", "utf8");
    const portsAndAdapters = readFileSync("docs/ports-and-adapters.md", "utf8");
    const moduleReference = readFileSync("docs/module-reference.md", "utf8");

    assert.match(moduleReference, /hypotheses\.ts[^\n]*repository\s*\/\s*DAO/i);
    assert.match(architecture, /established ports:\s*persistence, clock\/id, execution/i);
    assert.match(
        portsAndAdapters,
        /\[issue #38\]\(https:\/\/github\.com\/tomtastisch\/codex-orchestrator\/issues\/38\)/i,
        "the dynamic module-communication follow-up must link issue #38",
    );

    const allMaintainerDocs = [architecture, portsAndAdapters, moduleReference].join("\n");
    assert.doesNotMatch(allMaintainerDocs, /every (?:infrastructure dependency|port) is (?:already )?interchangeable/i);
    assert.doesNotMatch(allMaintainerDocs, /filesystem[^\n]*sits behind (?:those )?ports as (?:an )?interchangeable adapter/i);
});

test("every persistence consumer actually depends on the persistence port", () => {
    for (const consumer of manifest.persistenceConsumers) {
        const specs = importsOf(consumer);
        assert.ok(
            specs.some((spec) => spec.includes("ports/persistence")),
            `${consumer} does not import the PersistenceStore port`,
        );
    }
});

test("the persistence port inverts the dependency: it never imports the adapter", () => {
    for (const spec of importsOf(manifest.ports.persistence)) {
        assert.ok(!forbids(spec, "db"), `the port must not import the adapter (${spec})`);
        assert.ok(!forbids(spec, "node:sqlite"), `the port must stay technology-agnostic (${spec})`);
    }
});

test("the adapter implements the port (imports it back)", () => {
    const specs = importsOf(manifest.adapters.persistence);
    assert.ok(
        specs.some((spec) => spec.includes("ports/persistence")),
        "db.ts must import PersistenceStore to declare `implements`",
    );
});

test("infrastructure-independent core modules import ports but no concrete I/O", () => {
    assert.ok(Array.isArray(manifest.corePortConsumers), "corePortConsumers must be an explicit list");
    for (const consumer of manifest.corePortConsumers) {
        assert.ok(
            importsOf(consumer).some((spec) => spec.includes("ports/")),
            `${consumer} must express infrastructure needs through a port`,
        );
        for (const spec of importsOf(consumer)) {
            for (const forbidden of manifest.forbiddenCoreImports) {
                assert.ok(!forbids(spec, forbidden), `${consumer} must not import concrete I/O (${spec})`);
            }
        }
    }
});

test("no persistence consumer reaches through a raw SQL gateway", () => {
    // Import purity is necessary but not sufficient: a module can be import-clean
    // yet still execute SQL through a raw `store.db` handle. The port exposes no
    // such handle (see the next test), so every consumer must go through typed
    // methods. This scan is belt-and-suspenders against a `store.db.prepare(...)`
    // ever reappearing outside the adapter.
    for (const consumer of manifest.persistenceConsumers) {
        const source = readFileSync(consumer, "utf8");
        assert.doesNotMatch(
            source,
            /\.db\s*\.\s*(?:prepare|exec)\b/,
            `${consumer} must use typed PersistenceStore methods, not a raw .db gateway`,
        );
    }
});

test("the persistence port exposes no raw SQL gateway", () => {
    // The port must stay technology-agnostic: no `readonly db`, no SqlDatabase/
    // SqlStatement escape hatch that would couple consumers to the SQL engine.
    const source = readFileSync(manifest.ports.persistence, "utf8");
    assert.doesNotMatch(source, /\breadonly\s+db\b/, "the port must not expose a raw db handle");
    assert.doesNotMatch(source, /\bSql(?:Database|Statement)\b/, "the port must not define a raw SQL gateway type");
});

test("the import scanner catches every re-introduction form (regression guard for the guard)", () => {
    // If the scanner regresses to a naive `from "..."` match, the boundary tests
    // above become bypassable. Pin every specifier form the extractor must see.
    const sample = [
        'import { Store } from "./db.js";',
        "export { x } from './db.js';",
        'import "node:sqlite";',
        "import 'node:fs';",
        'const m = await import("../db.js");',
        "const n = import('node:child_process');",
        'const r = require("node:os");',
        'import type { T } from "./db.js";',
    ].join("\n");
    const specs = extractImports(sample);
    for (const expected of [
        "./db.js", "node:sqlite", "node:fs", "../db.js", "node:child_process", "node:os",
    ]) {
        assert.ok(specs.includes(expected), `scanner missed ${expected}`);
    }
});

test("server.ts is a composition root — no business logic, no tool registration", () => {
    const src = readFileSync("src/server.ts", "utf8");
    assert.doesNotMatch(
        src,
        /server\.register(?:Tool|Prompt)\(/,
        "server.ts must delegate registrations to the application layer, not register tools itself",
    );
    const specs = importsOf("src/server.ts");
    assert.ok(specs.some((s) => s.includes("app/context")), "server.ts must build the AppContext");
    assert.ok(specs.some((s) => s.includes("app/tools/")), "server.ts must wire the tool modules");
});

test("application tool modules depend on the port, never the persistence adapter", () => {
    const dir = manifest.toolModulesDir;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 4, "expected the extracted tool-use-case modules");
    for (const file of [...files.map((f) => `${dir}/${f}`), "src/app/prompts.ts"]) {
        for (const spec of importsOf(file)) {
            assert.ok(!forbids(spec, "db"), `${file} must use the AppContext port, not the adapter (${spec})`);
            assert.ok(!forbids(spec, "node:sqlite"), `${file} must not import node:sqlite (${spec})`);
        }
    }
});

test("the clock port stays technology-agnostic and its adapter implements it", () => {
    for (const spec of importsOf(manifest.ports.clock)) {
        assert.doesNotMatch(spec, /db\.js|system-clock/, `the clock port must not import a concrete adapter (${spec})`);
    }
    const adapter = importsOf(manifest.adapters.clock);
    assert.ok(adapter.some((spec) => spec.includes("ports/clock")), "system-clock.ts must import the Clock/IdGenerator ports");
});

test("the clock/id port is actually consumed — no dead abstraction", () => {
    // Mirrors the persistence-consumer test: the port must have real consumers,
    // or it silently rots into decorative dead code. Each listed consumer must
    // depend on the Clock/IdGenerator port (they receive it by injection and use
    // it instead of ambient nowIso/newId).
    assert.ok(manifest.clockConsumers.length >= 3, "expected the time/identity consumers");
    for (const consumer of manifest.clockConsumers) {
        const specs = importsOf(consumer);
        assert.ok(
            specs.some((spec) => spec.includes("ports/clock")),
            `${consumer} must depend on the Clock/IdGenerator port, not ambient time/identity`,
        );
        // Importing the port is not enough — a consumer could import IdGenerator
        // yet keep reading time via ambient `new Date()` (the bug this guards
        // against). Require an actual injected-clock call, and forbid ambient
        // wall-clock timestamp creation in these modules.
        const source = readFileSync(consumer, "utf8");
        assert.match(
            source,
            /\bclock\.now\(/,
            `${consumer} must read time via the injected Clock (clock.now()), not ambient new Date()`,
        );
        assert.doesNotMatch(
            source,
            /new Date\(\)\.toISOString\(\)/,
            `${consumer} must not create wall-clock timestamps ambiently; use clock.now()`,
        );
    }
    // And the composition root must inject the concrete adapter.
    assert.ok(
        importsOf("src/app/context.ts").some((spec) => spec.includes("system-clock")),
        "the composition root must inject systemClock/systemIdGenerator",
    );
});

test("core consumers cannot import concrete clock or execution adapters", () => {
    for (const consumer of manifest.clockConsumers) {
        for (const spec of importsOf(consumer)) {
            assert.ok(
                !forbids(spec, "system-clock"),
                `${consumer} must receive Clock/IdGenerator from composition (${spec})`,
            );
        }
    }
    const sessionImports = importsOf("src/session.ts");
    assert.ok(
        sessionImports.every((spec) => !forbids(spec, "local-target")),
        "SessionManager must receive ExecutionTarget lookup from composition",
    );
});

test("the default Clock and IdGenerator adapters satisfy their contracts", () => {
    const stamp = systemClock.now();
    assert.equal(typeof stamp, "string");
    assert.equal(stamp, new Date(stamp).toISOString(), "Clock.now must yield an ISO-8601 instant");
    assert.equal(systemClock.now, nowIso);

    const id = systemIdGenerator.newId("P");
    assert.match(id, /^P_[0-9a-f-]{12}$/, "IdGenerator.newId must return a prefix-tagged id");
    assert.equal(systemIdGenerator.newId, newId);
});
