import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    coverageArguments,
    discoverTests,
    extractCoverageSummary,
    formatCoverageMarkdown,
    writeCoverageEvidence,
} from "../scripts/lib/coverage.mjs";

test("coverage arguments scope metrics to production output and enforce floors", () => {
    assert.deepEqual(coverageArguments(["tests/a.test.mjs"]), [
        "--experimental-test-coverage",
        "--test-coverage-include=dist/**/*.js",
        "--test-coverage-lines=75",
        "--test-coverage-branches=70",
        "--test-coverage-functions=75",
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

test("coverage summary parser accepts Node's aggregate row", () => {
    const summary = extractCoverageSummary("ℹ all files | 77.39 | 75.52 | 77.74 |\n");
    assert.deepEqual(summary, { lines: 77.39, branches: 75.52, functions: 77.74 });
    assert.match(formatCoverageMarkdown(summary), /77\.39 %/);
});

test("coverage summary parser fails closed on missing output", () => {
    assert.throws(() => extractCoverageSummary("no coverage"), /aggregate coverage row/);
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
