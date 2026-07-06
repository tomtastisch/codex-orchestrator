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
    assert.equal(manifest.user_config.project_directory.type, "directory");
    assert.equal(manifest.user_config.project_directory.required, true);
    assert.equal(JSON.stringify(manifest).match(/token|api_key|auth\.json/gi), null);
});

test("MCPB launcher rejects missing, relative and non-directory project paths", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "orch-mcpb-file-")), "file");
    writeFileSync(filePath, "not a directory", "utf8");

    for (const [configured, expected] of [
        [undefined, /must be an absolute path/],
        ["relative/project", /must be an absolute path/],
        [filePath, /must be a directory/],
        [join(tmpdir(), "definitely-missing-orchestrator-project"), /must be a directory/],
    ]) {
        const env = { ...process.env };
        if (configured === undefined) delete env.ORCH_PROJECT_DIR;
        else env.ORCH_PROJECT_DIR = configured;
        const result = spawnSync(process.execPath, [launcherPath], {
            cwd: root,
            env,
            encoding: "utf8",
        });
        assert.notEqual(result.status, 0, `launcher unexpectedly accepted ${configured}`);
        assert.match(result.stderr, expected);
    }
});

test("MCPB launcher normalizes the project path before importing the server", () => {
    const fixture = mkdtempSync(join(tmpdir(), "orch-mcpb-launcher-"));
    const fixtureServerDir = join(fixture, "server");
    const project = join(fixture, "project");
    const observedCwd = join(fixture, "observed-cwd.txt");
    mkdirSync(fixtureServerDir);
    mkdirSync(project);
    copyFileSync(launcherPath, join(fixtureServerDir, "launcher.mjs"));
    writeFileSync(
        join(fixtureServerDir, "server.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(observedCwd)}, process.cwd(), "utf8");`,
        "utf8",
    );

    const configured = join(project, "..");
    const result = spawnSync(process.execPath, [join(fixtureServerDir, "launcher.mjs")], {
        cwd: root,
        env: { ...process.env, ORCH_PROJECT_DIR: configured },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(observedCwd, "utf8"), realpathSync(resolve(configured)));
});
