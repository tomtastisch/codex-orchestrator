import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/execution/ is the one genuine ports-&-adapters (hexagonal) island in this
// codebase: `types.ts` defines the ExecutionTarget port, `router.ts` is the
// application-layer selection logic, `local-target.ts` and `ssh/*` are adapters,
// and `registry.ts` is the composition root that wires concretes together.
// These tests lock that boundary so the dependency direction cannot silently rot.

const DIR = "src/execution";

/** Relative import specifiers used by an execution module. */
function importsOf(relPath) {
    const source = readFileSync(join(DIR, relPath), "utf8");
    return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

// The top-level god-modules the execution layer must never couple to.
const FORBIDDEN_GOD_MODULES = /(?:^|\/)(?:db|server)\.js$/;
const ADAPTER_FILES = ["local-target.ts", "ssh/target.ts", "ssh/client.ts", "ssh/deploy.ts", "ssh/protocol.ts"];
const ALL_FILES = ["types.ts", "router.ts", "errors.ts", "registry.ts", ...ADAPTER_FILES];

test("no execution module couples to the db or server god-modules", () => {
    for (const file of ALL_FILES) {
        for (const spec of importsOf(file)) {
            assert.doesNotMatch(spec, FORBIDDEN_GOD_MODULES, `${file} must not import ${spec}`);
        }
    }
});

test("the port and the router depend only on abstractions, never on a concrete adapter", () => {
    for (const file of ["types.ts", "router.ts"]) {
        for (const spec of importsOf(file)) {
            assert.doesNotMatch(
                spec,
                /local-target|\/ssh\//,
                `${file} inverts the dependency: it must not import a concrete adapter (${spec})`,
            );
        }
    }
});

test("adapters never cross-import each other or the router", () => {
    for (const file of ADAPTER_FILES) {
        const isSshAdapter = file.startsWith("ssh/");
        for (const spec of importsOf(file)) {
            assert.doesNotMatch(spec, /router\.js$/, `${file} adapter must not import the router (${spec})`);
            if (isSshAdapter) {
                assert.doesNotMatch(spec, /local-target/, `${file} must not cross-import the local adapter (${spec})`);
            } else {
                assert.doesNotMatch(spec, /\/ssh\//, `${file} must not cross-import the ssh adapter (${spec})`);
            }
        }
    }
});

test("only the composition root wires the concrete adapters together", () => {
    const registry = importsOf("registry.ts");
    assert.ok(
        registry.some((spec) => spec.includes("local-target")),
        "registry.ts must wire the local adapter",
    );
    assert.ok(
        registry.some((spec) => spec.includes("ssh/target")),
        "registry.ts must wire the ssh adapter",
    );
});
