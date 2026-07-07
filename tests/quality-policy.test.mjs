import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r\n", "\n");

test("package supports only the verified Node LTS lines", () => {
    assert.equal(pkg.engines.node, ">=22.5.0 <23 || >=24 <25");
    assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24");
});

test("CI requires the complete Node and operating-system matrix", () => {
    assert.match(ci, /^permissions:\n  contents: read$/m);
    for (const value of [
        "ubuntu-latest",
        "macos-15",
        "windows-latest",
        '"22.5.0"',
        '"22"',
        '"24.0.0"',
        '"24"',
    ]) {
        assert.ok(ci.includes(value), `CI matrix entry missing: ${value}`);
    }
    assert.match(ci, /node:\s*\["22\.5\.0", "22", "24\.0\.0", "24"\]/);
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
    assert.match(ci, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
    assert.match(ci, /retention-days: 7/);
    assert.match(ci, /coverage\/summary\.txt/);
    assert.match(ci, /release\/\*\.mcpb/);
    assert.match(ci, /release\/\*\.sha256/);
});

test("CodeQL scans application and workflow code with current actions", () => {
    assert.equal(existsSync(".github/workflows/codeql.yml"), true);
    const codeql = readFileSync(".github/workflows/codeql.yml", "utf8").replaceAll("\r\n", "\n");
    assert.match(codeql, /javascript-typescript/);
    assert.match(codeql, /language: actions/);
    assert.match(codeql, /queries: security-and-quality/);
    assert.match(codeql, /github\/codeql-action\/init@54f647b7e1bb85c95cddabcd46b0c578ec92bc1a # v4\.36\.3/);
    assert.match(codeql, /github\/codeql-action\/analyze@54f647b7e1bb85c95cddabcd46b0c578ec92bc1a # v4\.36\.3/);
    assert.match(codeql, /security-events: write/);
    assert.match(codeql, /actions: read/);
    assert.doesNotMatch(codeql, /packages: read/);
    assert.match(codeql, /schedule:/);
    assert.doesNotMatch(codeql, /continue-on-error:\s*true/);
});

test("every external GitHub Action is pinned to an immutable reviewed commit", () => {
    for (const path of [
        ".github/workflows/ci.yml",
        ".github/workflows/codeql.yml",
        ".github/workflows/release.yml",
    ]) {
        const workflow = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
        const externalUses = [...workflow.matchAll(/^\s*-?\s*uses:\s+([^\s#]+)(?:\s+#\s+(\S+))?\s*$/gm)]
            .filter((match) => !match[1].startsWith("./"));
        assert.ok(externalUses.length > 0, `external actions missing from ${path}`);
        for (const [, reference, release] of externalUses) {
            assert.match(reference, /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?@[0-9a-f]{40}$/, reference);
            assert.match(release ?? "", /^v\d+\.\d+\.\d+$/, `${reference} lacks an audited release comment`);
        }
    }
});
