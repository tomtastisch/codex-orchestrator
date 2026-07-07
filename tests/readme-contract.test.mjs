import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const submission = readFileSync("docs/distribution/anthropic-plugin-submission.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = readFileSync("src/server.ts", "utf8");

function registeredNames(kind) {
    return [...server.matchAll(new RegExp(`server\\.register${kind}\\(\\s*"([^"]+)"`, "g"))]
        .map((match) => match[1]);
}

test("README states the exact platform support status", () => {
    assert.match(readme, /Claude Code CLI\s*\|\s*Production ready/);
    assert.ok(readme.includes(
        `| Claude Desktop MCPB | Released; technical verification passed | Latest GitHub release, version ${pkg.version} |`,
    ));
    assert.match(readme, /claude\.ai Remote MCP[^\n]*\|\s*In development/);
    assert.match(readme, /Claude Desktop is not a prerequisite/);
    assert.match(readme, /technical verification (?:has )?passed/i);
    assert.doesNotMatch(readme, /Claude Desktop MCPB \(release candidate\)/i);
});

test("README lists executable prerequisites and lifecycle commands", () => {
    for (const command of [
        "node --version", "git --version", "codex --version", "codex login status",
        "claude --version", "claude plugin marketplace add tomtastisch/codex-orchestrator",
        "claude plugin install codex-orchestrator@codex-orchestrator --scope user",
        "claude plugin marketplace update codex-orchestrator",
        "claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes",
        "claude plugin list --json", "claude mcp list",
    ]) assert.ok(readme.includes(command), `README command missing: ${command}`);
});

test("README distinguishes every distribution and discovery channel", () => {
    assert.match(readme, /First-party GitHub marketplace/);
    assert.match(readme, /claude-community/);
    assert.match(readme, /claude-plugins-official/);
    assert.match(readme, /no application process/i);
    assert.match(readme, /independent community director(?:y|ies)/i);
    assert.ok(readme.includes("https://buildwithclaude.com"));
    assert.ok(readme.includes("https://crossaitools.com"));
    assert.doesNotMatch(readme, /Official marketplace for the Codex Orchestrator/);
});

test("README and submission record reflect Anthropic acknowledgement without claiming approval", () => {
    assert.match(submission, /^Status: Submitted; Anthropic review pending$/m);
    assert.match(submission, /Submission acknowledgement received: 2026-07-06/);
    assert.match(readme, /claude-community[^\n]*\|\s*Submitted; Anthropic review pending/);
    assert.doesNotMatch(readme, /Submission prepared; not yet listed/);
    assert.doesNotMatch(submission, /^Status: (?:Approved|Listed)/m);
});

test("README and submission record expose current independent-directory states", () => {
    assert.ok(readme.includes("https://github.com/davepoon/buildwithclaude/pull/222"));
    assert.match(readme, /Build with Claude[^\n]*PR #222 pending maintainer review/);
    assert.match(readme, /Cross AI Tools[^\n]*Crawler-eligible; listing depends on external quality and editorial review/);
    assert.ok(submission.includes("https://github.com/davepoon/buildwithclaude/pull/222"));
    assert.match(submission, /Cross AI Tools has no direct submission form/i);
});

test("README documents the complete Claude Desktop MCPB lifecycle", () => {
    for (const required of [
        "https://github.com/tomtastisch/codex-orchestrator/releases/latest",
        `codex-orchestrator-${pkg.version}.mcpb`,
        "Settings → Extensions → Advanced settings → Install Extension",
        "codex_orchestrator",
        "orchestrator_status",
        "orchestrator_doctor",
        "~/Library/Logs/Claude",
    ]) assert.ok(readme.includes(required), `README Desktop instruction missing: ${required}`);

    assert.match(readme, /Codex CLI[\s\S]*codex login status/);
    assert.match(readme, /Claude Desktop[\s\S]*installed locally and\s+authenticated/i);
    assert.match(readme, /does not request, copy or bundle[\s\S]*?auth\.json/i);
    assert.match(readme, /does not request an installation or project path/i);
    assert.match(readme, /repository path[\s\S]*?per orchestration request/i);
    assert.doesNotMatch(readme, /project_directory/);
});

test("README inventory matches every registered MCP prompt and tool", () => {
    const prompts = registeredNames("Prompt");
    const tools = registeredNames("Tool");
    assert.deepEqual(prompts, ["codex_orchestrator", "orchestrator_status"]);
    assert.equal(tools.length, 17);
    for (const name of [...prompts, ...tools]) {
        assert.ok(readme.includes(`| \`${name}\` |`), `README inventory missing: ${name}`);
    }
});

test("README states the immutable current-version and single-release policy", () => {
    assert.ok(readme.includes(`Current version: ${pkg.version}`));
    assert.match(readme, /exactly one current stable GitHub release and one corresponding\s+version tag/i);
    assert.match(readme, /CHANGELOG\.md[\s\S]*Git history/i);
    assert.doesNotMatch(readme, /releases\/tag\/v\d+\.\d+\.\d+/);
});

test("README documents implemented environment controls without stale claims", () => {
    for (const variable of [
        "ORCH_HOME", "ORCH_CONFIG_FILE", "ORCH_GLOBAL", "ORCH_MAX_CONCURRENT",
        "ORCH_SIGN_MERGE", "ORCH_CODEX_BIN", "ORCH_REQUIRE_HYPOTHESIS",
        "ORCH_MODEL_FAST", "ORCH_MODEL_BALANCED", "ORCH_MODEL_STRONG",
    ]) assert.ok(readme.includes(variable), `README environment variable missing: ${variable}`);

    assert.doesNotMatch(readme, /no update runs implicitly at startup/i);
    assert.match(readme, /Codex CLI is updated only after an explicit `codex_update` call/i);
});

test("README documents the verified runtime and quality matrix", () => {
    assert.match(readme, /Node\.js 22\.13–22\.x and Node\.js 24\.x/);
    for (const platform of ["Ubuntu", "macOS", "Windows"]) assert.ok(readme.includes(platform));
    assert.match(readme, /75 % lines, 70 % branches and 75 % functions/);
    assert.match(readme, /CodeQL/);
});
