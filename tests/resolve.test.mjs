import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("model resolution honors explicit models and effort classes", async () => {
    const { config, resolveModel } = await import("../dist/resolve.js");
    assert.equal(resolveModel("explicit-model", "low"), "explicit-model");
    assert.equal(resolveModel("auto", "low"), config.models.find((model) => model.class === "fast").model);
    assert.equal(resolveModel("auto", "medium"), config.models.find((model) => model.class === "balanced").model);
    assert.equal(resolveModel("auto", "high"), config.models.find((model) => model.class === "strong").model);
    assert.equal(resolveModel("auto", "xhigh"), config.models.find((model) => model.class === "strong").model);
});

test("cluster repository and latest worktree resolution fail closed", async () => {
    const { latestWorktreeForCluster, repoPathForCluster } = await import("../dist/resolve.js");
    const repository = mkdtempSync(join(tmpdir(), "orch-resolve-repo-"));
    try {
        assert.equal(spawnSync("git", ["init", "-q"], { cwd: repository }).status, 0);
        const store = {
            getCluster(id) {
                return id === "C1" ? { id, plan_id: "P1" } : undefined;
            },
            getPlan(id) {
                return id === "P1" ? { id, repo_path: repository } : undefined;
            },
            listTasks({ clusterId }) {
                return clusterId === "C1"
                    ? [{ worktree: null }, { worktree: "/tmp/worktree-one" }, { worktree: "/tmp/worktree-two" }]
                    : [];
            },
        };

        assert.equal(repoPathForCluster(store, "C1"), realpathSync(repository));
        assert.equal(repoPathForCluster(store, "missing"), null);
        assert.equal(latestWorktreeForCluster(store, "C1"), "/tmp/worktree-two");
        assert.equal(latestWorktreeForCluster(store, "missing"), null);

        const invalidPlanStore = { ...store, getPlan: () => ({ repo_path: join(repository, "missing") }) };
        assert.equal(repoPathForCluster(invalidPlanStore, "C1"), null);
    } finally {
        rmSync(repository, { recursive: true, force: true });
    }
});
