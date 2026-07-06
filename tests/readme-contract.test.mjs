import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");

test("README states the exact platform support status", () => {
    assert.match(readme, /Claude Code CLI\s*\|\s*Produktionsbereit/);
    assert.match(readme, /Claude Desktop MCPB[^\n]*\|\s*In Entwicklung/);
    assert.match(readme, /claude\.ai Remote MCP[^\n]*\|\s*In Entwicklung/);
    assert.match(readme, /Claude Desktop ist keine Voraussetzung/);
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

test("README distinguishes first-party availability from Anthropic approval", () => {
    assert.match(readme, /First-party GitHub marketplace/);
    assert.match(readme, /not yet listed in the official Anthropic marketplace/i);
    assert.doesNotMatch(readme, /Official marketplace for the Codex Orchestrator/);
});

test("README documents the complete Claude Desktop MCPB lifecycle", () => {
    for (const required of [
        "https://github.com/tomtastisch/codex-orchestrator/releases/tag/v1.5.0",
        "codex-orchestrator-1.5.0.mcpb",
        "Settings → Extensions → Advanced settings → Install Extension",
        "project_directory",
        "codex_orchestrator",
        "orchestrator_status",
        "orchestrator_doctor",
        "~/Library/Logs/Claude",
    ]) assert.ok(readme.includes(required), `README Desktop instruction missing: ${required}`);

    assert.match(readme, /Codex CLI[\s\S]*codex login status/);
    assert.match(readme, /Claude Desktop[\s\S]*installed locally and\s+authenticated/i);
    assert.match(readme, /does not request, copy or bundle[\s\S]*?auth\.json/i);
});
