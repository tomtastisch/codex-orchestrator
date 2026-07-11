import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, win32 } from "node:path";
import { extractImports } from "./helpers/imports.mjs";

// src/execution/ is the one genuine ports-&-adapters (hexagonal) island in this
// codebase: `types.ts` defines the ExecutionTarget port, `router.ts` is the
// application-layer selection logic, `local-target.ts` and `ssh/*` are adapters,
// and `registry.ts` is the composition root that wires concretes together.
// These tests lock that boundary so the dependency direction cannot silently rot.

const DIR = "src/execution";
const manifest = JSON.parse(readFileSync("ssot/architecture.json", "utf8"));

/** Every import specifier an execution module uses, in any form (see helpers/imports.mjs). */
function importsOf(relPath) {
    return extractImports(readFileSync(join(DIR, relPath), "utf8"));
}

/** Every import specifier a repo-relative source module uses. */
function sourceImportsOf(srcPath) {
    return extractImports(readFileSync(srcPath, "utf8"));
}

/** Resolve a relative source import to its repo-relative TypeScript path. */
function importedSourcePath(srcPath, specifier, pathApi = { dirname, join, relative }) {
    if (!specifier.startsWith(".")) return null;
    const resolved = pathApi.join(pathApi.dirname(srcPath), specifier.replace(/\.js$/, ".ts"));
    return pathApi.relative(".", resolved).replaceAll("\\", "/");
}

// The top-level god-modules the execution layer must never couple to.
const FORBIDDEN_GOD_MODULES = /(?:^|\/)(?:db|server)\.js$/;
const ADAPTER_FILES = ["local-target.ts", "ssh/target.ts", "ssh/client.ts", "ssh/deploy.ts", "ssh/protocol.ts"];
const ALL_FILES = ["types.ts", "router.ts", "errors.ts", "registry.ts", ...ADAPTER_FILES];

test("repo-relative import paths use POSIX separators on Windows", () => {
    assert.equal(
        importedSourcePath("src\\session.ts", "./execution/types.js", win32),
        manifest.ports.execution,
    );
});

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

test("declared execution consumers depend on the port, never concrete target adapters", () => {
    assert.deepEqual(
        manifest.executionPortConsumers,
        ["src/session.ts", "src/checks.ts", "src/execution/router.ts"],
        "the architecture SSOT must enumerate the established ExecutionTarget consumers",
    );
    for (const consumer of manifest.executionPortConsumers) {
        const imports = sourceImportsOf(consumer);
        assert.ok(
            imports.some((specifier) => importedSourcePath(consumer, specifier) === manifest.ports.execution),
            `${consumer} must consume the ExecutionTarget port`,
        );
        for (const specifier of imports) {
            assert.doesNotMatch(
                specifier,
                /execution\/local-target|execution\/ssh\//,
                `${consumer} must receive ExecutionTarget from composition (${specifier})`,
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
