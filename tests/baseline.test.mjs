import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

test("package, lockfile and Claude plugin versions agree", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    const plugin = readJson(".claude-plugin/plugin.json");
    const runtimeVersion = readFileSync("src/version.ts", "utf8").match(/ORCHESTRATOR_VERSION = "([^"]+)"/)?.[1];

    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(plugin.version, pkg.version);
    assert.equal(runtimeVersion, pkg.version);
});

test("npm test always builds ignored dist artifacts first", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.scripts.pretest, "npm run build");
});

test("bundle verification is part of the package scripts", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.scripts["verify:bundle"], "node scripts/verify-bundle.mjs");
    assert.equal(existsSync("scripts/verify-bundle.mjs"), true);
});

test("Claude plugin keeps project state outside the ephemeral plugin cache", () => {
    const plugin = readJson(".claude-plugin/plugin.json");
    const server = plugin.mcpServers["codex-orchestrator"];
    assert.equal(server.args[0], "${CLAUDE_PLUGIN_ROOT}/bundle/server.mjs");
    assert.equal(server.env.ORCH_HOME, "${CLAUDE_PROJECT_DIR}/.orchestrator");

    const skill = readFileSync("skills/codex-orchestrator/SKILL.md", "utf8");
    assert.match(skill, /argument-hint:/);
    assert.match(skill, /\$ARGUMENTS/);
    assert.match(skill, /orchestrator_doctor/);
});

test("marketplace identifies itself as first-party, not Anthropic-official", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    assert.match(marketplace.description, /First-party/);
    assert.doesNotMatch(marketplace.description, /Official marketplace/i);
});
