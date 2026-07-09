import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { systemClock, systemIdGenerator, nowIso, newId } from "../dist/system-clock.js";
import { extractImports } from "./helpers/imports.mjs";

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
    assert.equal(manifest.adapters.persistence, "src/db.ts");
    assert.equal(manifest.ports.persistence, "src/ports/persistence.ts");
    assert.ok(manifest.persistenceConsumers.length >= 8, "expected the known db.js consumers");
    for (const pure of manifest.domainPure) {
        assert.ok(
            manifest.persistenceConsumers.includes(pure),
            `${pure} is domain-pure but not listed as a persistence consumer`,
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

test("domain-pure modules have no I/O imports at all", () => {
    for (const pure of manifest.domainPure) {
        for (const spec of importsOf(pure)) {
            assert.ok(!forbids(spec, "db"), `${pure} (domain) must not import the persistence adapter (${spec})`);
            for (const forbidden of manifest.forbiddenDomainImports) {
                assert.ok(
                    !forbids(spec, forbidden),
                    `${pure} is domain-pure and must not perform I/O (${spec})`,
                );
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
    }
    // And the composition root must inject the concrete adapter.
    assert.ok(
        importsOf("src/app/context.ts").some((spec) => spec.includes("system-clock")),
        "the composition root must inject systemClock/systemIdGenerator",
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
