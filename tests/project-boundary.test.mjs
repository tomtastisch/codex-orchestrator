import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
    assertGitRepositoryRoot,
} from "../dist/project-boundary.js";

function createRepository(prefix) {
    const repository = mkdtempSync(join(tmpdir(), prefix));
    const result = spawnSync("git", ["init", "-q"], { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return repository;
}

test("every requested project must be one exact Git repository root", () => {
    const repository = createRepository("orch-project-root-");
    const nested = join(repository, "nested");
    const sibling = createRepository("orch-project-sibling-");
    const nonGit = mkdtempSync(join(tmpdir(), "orch-project-non-git-"));
    mkdirSync(nested);

    assert.throws(
        () => assertGitRepositoryRoot("relative/repository"),
        /must be an absolute path/,
    );
    assert.throws(
        () => assertGitRepositoryRoot(nonGit),
        /repo_path must be a Git repository root/,
    );
    assert.equal(assertGitRepositoryRoot(repository), realpathSync(repository));
    assert.equal(assertGitRepositoryRoot(sibling), realpathSync(sibling));
    assert.throws(
        () => assertGitRepositoryRoot(nested),
        /repo_path must be a Git repository root/,
    );
});

test("MCP validates each repository per request without installation configuration", async () => {
    const repository = createRepository("orch-request-server-root-");
    const sibling = createRepository("orch-request-server-sibling-");
    const nonGit = mkdtempSync(join(tmpdir(), "orch-request-server-non-git-"));
    const orchHome = mkdtempSync(join(tmpdir(), "orch-boundary-server-home-"));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist", "server.js")],
        env: {
            ...process.env,
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
        const invalid = await client.callTool({
            name: "cluster_plan",
            arguments: {
                goal: "must be rejected",
                repo_path: nonGit,
                clusters: [],
            },
        });
        assert.equal(invalid.isError, true);
        assert.match(invalid.content[0].text, /repo_path must be a Git repository root/);

        const inside = await client.callTool({
            name: "cluster_plan",
            arguments: {
                goal: "allowed plan",
                repo_path: repository,
                clusters: [{
                    id: "C_request",
                    name: "Request boundary",
                    goal: "Validate repository handling",
                }],
            },
        });
        assert.equal(inside.isError, undefined);
        const insideReport = JSON.parse(inside.content[0].text);
        assert.equal(insideReport.ok, true);

        const mismatchedPlanRepository = await client.callTool({
            name: "cluster_plan",
            arguments: {
                plan_id: insideReport.plan_id,
                goal: "must keep the original repository",
                repo_path: sibling,
                clusters: [],
            },
        });
        assert.equal(mismatchedPlanRepository.isError, true);
        assert.match(
            mismatchedPlanRepository.content[0].text,
            /repo_path does not match the existing plan repository/,
        );

        const secondRepository = await client.callTool({
            name: "cluster_plan",
            arguments: {
                goal: "second allowed plan",
                repo_path: sibling,
                clusters: [],
            },
        });
        assert.equal(secondRepository.isError, undefined);
        assert.equal(JSON.parse(secondRepository.content[0].text).ok, true);

        const emptyRepository = await client.callTool({
            name: "task_start",
            arguments: {
                repo_path: "",
                instructions: "must reject an empty repository path",
                sandbox: "read-only",
                model: "auto",
                wait_for: "started",
            },
        });
        assert.equal(emptyRepository.isError, true);
        assert.match(emptyRepository.content[0].text, /repo_path must be an absolute path/);

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
        assert.match(explicitWorktree.content[0].text, /Expected 'none' \| 'auto'/);

        const doctor = await client.callTool({
            name: "orchestrator_doctor",
            arguments: {},
        });
        const report = JSON.parse(doctor.content[0].text);
        assert.equal(report.ok, true);
        assert.equal(report.project_mode, "per-request-git-root");
        assert.equal("project_root" in report, false);

        rmSync(repository, { recursive: true, force: true });
        const missingPersistedRepository = await client.callTool({
            name: "repo_check",
            arguments: {
                cluster_id: "C_request",
                checks: [],
            },
        });
        assert.equal(missingPersistedRepository.isError, true);
        assert.match(missingPersistedRepository.content[0].text, /Plan-Repo für Cluster nicht gefunden/);
        assert.doesNotMatch(missingPersistedRepository.content[0].text, /Internal error/i);
    } finally {
        await client.close();
    }
});
