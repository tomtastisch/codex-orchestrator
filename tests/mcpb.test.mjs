import { test } from "node:test";
import assert from "node:assert/strict";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "packaging", "mcpb", "manifest.json");
const launcherPath = join(root, "packaging", "mcpb", "server", "launcher.mjs");

test("MCPB manifest is version-aligned and never configures credentials", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    assert.equal(manifest.manifest_version, "0.3");
    assert.equal(manifest.name, "codex-orchestrator");
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.server.type, "node");
    assert.equal(manifest.server.entry_point, "server/launcher.mjs");
    assert.equal("user_config" in manifest, false);
    assert.equal("ORCH_PROJECT_DIR" in manifest.server.mcp_config.env, false);
    assert.equal(manifest.server.mcp_config.env.ORCH_HOME, "${HOME}/.codex-orchestrator/desktop");
    assert.deepEqual(manifest.compatibility.platforms, ["darwin", "win32"]);
    assert.equal(JSON.stringify(manifest).match(/token|api_key|auth\.json/gi), null);
});

test("MCPB launcher starts without project configuration and clears inherited boundaries", () => {
    const fixture = mkdtempSync(join(tmpdir(), "orch-mcpb-launcher-"));
    const fixtureServerDir = join(fixture, "server");
    const observed = join(fixture, "observed.json");
    mkdirSync(fixtureServerDir);
    copyFileSync(launcherPath, join(fixtureServerDir, "launcher.mjs"));
    writeFileSync(
        join(fixtureServerDir, "server.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), project: process.env.ORCH_PROJECT_DIR ?? null }), "utf8");`,
        "utf8",
    );

    const result = spawnSync(process.execPath, [join(fixtureServerDir, "launcher.mjs")], {
        cwd: root,
        env: { ...process.env, ORCH_PROJECT_DIR: "/must/not/be/inherited" },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(readFileSync(observed, "utf8"));
    assert.equal(data.cwd, realpathSync(root));
    assert.equal(data.project, null);
});
