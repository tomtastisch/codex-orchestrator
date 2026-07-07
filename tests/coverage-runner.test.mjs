import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    coverageArguments,
    discoverTests,
    formatCoverageMarkdown,
    writeCoverageEvidence,
} from "../scripts/lib/coverage.mjs";
import * as coverage from "../scripts/lib/coverage.mjs";

test("coverage arguments scope metrics to production output and enforce floors", () => {
    assert.deepEqual(coverageArguments(["tests/a.test.mjs"]), [
        "--all",
        "--include=dist/**/*.js",
        "--check-coverage",
        "--lines=75",
        "--branches=70",
        "--functions=75",
        "--reporter=text",
        "--reporter=json-summary",
        "--reports-dir=coverage",
        "node",
        "--test",
        "tests/a.test.mjs",
    ]);
});

test("test discovery returns only sorted top-level test modules", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-tests-"));
    try {
        mkdirSync(join(root, "tests"));
        writeFileSync(join(root, "tests", "z.test.mjs"), "");
        writeFileSync(join(root, "tests", "a.test.mjs"), "");
        writeFileSync(join(root, "tests", "fixture.mjs"), "");
        assert.deepEqual(discoverTests(root), ["tests/a.test.mjs", "tests/z.test.mjs"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coverage summary includes every compiled production module", () => {
    assert.equal(typeof coverage.discoverProductionModules, "function");
    assert.equal(typeof coverage.readCoverageSummary, "function");
    const root = mkdtempSync(join(tmpdir(), "coverage-inventory-"));
    try {
        mkdirSync(join(root, "dist", "nested"), { recursive: true });
        mkdirSync(join(root, "coverage"));
        writeFileSync(join(root, "dist", "a.js"), "export {};\n");
        writeFileSync(join(root, "dist", "nested", "b.js"), "export {};\n");
        const summaryPath = join(root, "coverage", "coverage-summary.json");
        const totals = {
            lines: { pct: 77.39 },
            branches: { pct: 75.52 },
            functions: { pct: 77.74 },
        };
        writeFileSync(summaryPath, JSON.stringify({
            total: totals,
            [join(root, "dist", "a.js")]: totals,
        }));

        const modules = coverage.discoverProductionModules(root);
        assert.deepEqual(modules, ["dist/a.js", "dist/nested/b.js"]);
        assert.throws(
            () => coverage.readCoverageSummary(root, modules),
            /missing production modules.*dist\/nested\/b\.js/i,
        );

        writeFileSync(summaryPath, JSON.stringify({
            total: totals,
            [join(root, "dist", "a.js")]: totals,
            [join(root, "dist", "nested", "b.js")]: totals,
        }));
        const summary = coverage.readCoverageSummary(root, modules);
        assert.deepEqual(summary, { lines: 77.39, branches: 75.52, functions: 77.74 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coverage summary reader fails closed on malformed evidence", () => {
    assert.equal(typeof coverage.readCoverageSummary, "function");
    const root = mkdtempSync(join(tmpdir(), "coverage-malformed-"));
    try {
        mkdirSync(join(root, "coverage"));
        writeFileSync(join(root, "coverage", "coverage-summary.json"), "{}", "utf8");
        assert.throws(() => coverage.readCoverageSummary(root, []), /invalid coverage summary/i);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coverage Markdown formats c8 aggregate percentages", () => {
    const summary = { lines: 77.39, branches: 75.52, functions: 77.74 };
    assert.match(formatCoverageMarkdown(summary), /77\.39 %/);
});

test("coverage evidence is replaced atomically and appended to GitHub summary", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-evidence-"));
    const githubSummaryPath = join(root, "github-summary.md");
    try {
        writeCoverageEvidence({
            root,
            summary: { lines: 77.39, branches: 75.52, functions: 77.74 },
            githubSummaryPath,
        });
        const evidence = readFileSync(join(root, "coverage", "summary.txt"), "utf8");
        assert.match(evidence, /Production coverage/);
        assert.equal(readFileSync(githubSummaryPath, "utf8"), evidence);
        assert.equal(existsSync(join(root, "coverage", "summary.txt.tmp")), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
