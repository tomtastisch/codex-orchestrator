import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("domain-pure modules never reach through the raw SQL gateway either", () => {
    // Import purity is necessary but not sufficient: a module can be import-clean
    // yet still execute SQL through the injected `store.db` escape hatch. A truly
    // pure module touches neither. This guards the honesty of the `domainPure`
    // claim against exactly the leak that would otherwise slip past an
    // import-only scan (e.g. `store.db.prepare(...)`).
    for (const pure of manifest.domainPure) {
        const source = readFileSync(pure, "utf8");
        assert.doesNotMatch(
            source,
            /\.db\s*\.\s*(?:prepare|exec)\b/,
            `${pure} claims to be domain-pure but issues raw SQL via the .db gateway`,
        );
    }
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

test("the clock port stays technology-agnostic and its adapter implements it", () => {
    for (const spec of importsOf(manifest.ports.clock)) {
        assert.doesNotMatch(spec, /db\.js|system-clock/, `the clock port must not import a concrete adapter (${spec})`);
    }
    const adapter = importsOf(manifest.adapters.clock);
    assert.ok(adapter.some((spec) => spec.includes("ports/clock")), "system-clock.ts must import the Clock/IdGenerator ports");
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
