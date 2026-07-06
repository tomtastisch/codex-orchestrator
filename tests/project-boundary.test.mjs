import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
    assertProjectPathAllowed,
    resolveConfiguredProjectRoot,
} from "../dist/project-boundary.js";

function createRepository(prefix) {
    const repository = mkdtempSync(join(tmpdir(), prefix));
    const result = spawnSync("git", ["init", "-q"], { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return repository;
}

test("configured Desktop project must be one exact Git repository root", () => {
    const repository = createRepository("orch-project-root-");
    const nested = join(repository, "nested");
    const sibling = createRepository("orch-project-sibling-");
    const nonGit = mkdtempSync(join(tmpdir(), "orch-project-non-git-"));
    mkdirSync(nested);

    assert.equal(resolveConfiguredProjectRoot(undefined), null);
    assert.throws(
        () => resolveConfiguredProjectRoot("relative/repository"),
        /must be an absolute path/,
    );
    assert.throws(
        () => resolveConfiguredProjectRoot(nonGit),
        /must be a Git repository root/,
    );

    const configuredRoot = resolveConfiguredProjectRoot(repository);
    assert.equal(configuredRoot, realpathSync(repository));
    assert.equal(assertProjectPathAllowed(repository, configuredRoot), configuredRoot);
    assert.throws(
        () => assertProjectPathAllowed(nested, configuredRoot),
        /outside the configured project repository/,
    );
    assert.throws(
        () => assertProjectPathAllowed(sibling, configuredRoot),
        /outside the configured project repository/,
    );
    assert.throws(
        () => assertProjectPathAllowed("relative/repository", configuredRoot),
        /must be an absolute path/,
    );
});

test("MCP plan creation cannot escape the configured Desktop repository", async () => {
    const repository = createRepository("orch-boundary-server-root-");
    const sibling = createRepository("orch-boundary-server-sibling-");
    const orchHome = mkdtempSync(join(tmpdir(), "orch-boundary-server-home-"));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "bundle", "server.mjs")],
        env: {
            ...process.env,
            ORCH_PROJECT_DIR: repository,
            ORCH_HOME: orchHome,
            ORCH_CODEX_BIN: join(process.cwd(), "tests", "fixtures", "fake-codex.mjs"),
            ORCH_REQUIRE_HYPOTHESIS: "false",
            SKIP_PLUGIN_MARKETPLACE: "true",
        },
        stderr: "pipe",
    });
    const client = new Client(
        { name: "project-boundary-test", version: "1.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);
        const outside = await client.callTool({
            name: "cluster_plan",
            arguments: {
                goal: "must be rejected",
                repo_path: sibling,
                clusters: [],
            },
        });
        assert.equal(outside.isError, true);
        assert.match(outside.content[0].text, /outside the configured project repository/);

        const inside = await client.callTool({
            name: "cluster_plan",
            arguments: {
                goal: "allowed plan",
                repo_path: repository,
                clusters: [],
            },
        });
        assert.equal(inside.isError, undefined);
        assert.equal(JSON.parse(inside.content[0].text).ok, true);

        const explicitWorktree = await client.callTool({
            name: "task_start",
            arguments: {
                repo_path: repository,
                instructions: "must not run outside the configured repository",
                sandbox: "read-only",
                model: "auto",
                worktree: sibling,
                wait_for: "started",
            },
        });
        assert.equal(explicitWorktree.isError, true);
        assert.match(explicitWorktree.content[0].text, /explicit worktree paths are disabled/);

        const doctor = await client.callTool({
            name: "orchestrator_doctor",
            arguments: {},
        });
        const report = JSON.parse(doctor.content[0].text);
        assert.equal(report.ok, true);
        assert.equal(report.project_root, realpathSync(repository));
    } finally {
        await client.close();
    }
});
