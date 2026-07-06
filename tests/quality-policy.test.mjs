import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

test("package supports only the verified Node LTS lines", () => {
    assert.equal(pkg.engines.node, ">=22.5.0 <23 || >=24 <25");
    assert.equal(readFileSync(".nvmrc", "utf8"), "24\n");
});

test("CI requires the complete Node and operating-system matrix", () => {
    for (const value of ["ubuntu-latest", "macos-15", "windows-latest", '"22"', '"24"']) {
        assert.ok(ci.includes(value), `CI matrix entry missing: ${value}`);
    }
    assert.match(ci, /portable:[\s\S]*fail-fast: false/);
    assert.match(
        ci,
        /portable:[\s\S]*npm run typecheck[\s\S]*npm test[\s\S]*npm run bundle[\s\S]*npm run verify:bundle/,
    );
    assert.doesNotMatch(ci, /continue-on-error:\s*true/);
});

test("canonical quality gate enforces coverage and release-candidate checks", () => {
    for (const command of [
        "npm run test:coverage",
        "npm run mcpb:validate",
        "npm run mcpb:build",
        "npm run mcpb:verify",
        "npm run benchmark",
        "node scripts/bundlecheck.mjs",
        "plugin validate . --strict",
        "npm audit --audit-level=moderate",
    ]) assert.ok(ci.includes(command), `quality command missing: ${command}`);
    assert.match(ci, /actions\/upload-artifact@v7/);
    assert.match(ci, /retention-days: 7/);
    assert.match(ci, /coverage\/summary\.txt/);
    assert.match(ci, /release\/\*\.mcpb/);
    assert.match(ci, /release\/\*\.sha256/);
});

test("CodeQL scans application and workflow code with current actions", () => {
    assert.equal(existsSync(".github/workflows/codeql.yml"), true);
    const codeql = readFileSync(".github/workflows/codeql.yml", "utf8");
    assert.match(codeql, /javascript-typescript/);
    assert.match(codeql, /language: actions/);
    assert.match(codeql, /queries: security-and-quality/);
    assert.match(codeql, /github\/codeql-action\/init@v4/);
    assert.match(codeql, /github\/codeql-action\/analyze@v4/);
    assert.match(codeql, /security-events: write/);
    assert.match(codeql, /schedule:/);
    assert.doesNotMatch(codeql, /continue-on-error:\s*true/);
});
