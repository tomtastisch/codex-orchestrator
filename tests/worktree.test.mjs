import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(repository, args) {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

test("worktree manager creates, lists, merges and removes isolated branches", async () => {
    const { WorktreeManager, isGitRepo } = await import("../dist/worktree.js");
    const root = mkdtempSync(join(tmpdir(), "orch-worktree-manager-"));
    const repository = join(root, "repository");
    const worktrees = join(root, "worktrees");
    try {
        assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
        git(repository, ["config", "user.email", "test@example.invalid"]);
        git(repository, ["config", "user.name", "Test"]);
        writeFileSync(join(repository, "base.txt"), "base\n");
        git(repository, ["add", "base.txt"]);
        git(repository, ["commit", "-q", "-m", "base"]);
        assert.equal(isGitRepo(repository), true);
        assert.equal(isGitRepo(root), false);

        const manager = new WorktreeManager(worktrees);
        const created = manager.create(repository, "T1");
        assert.equal(created.branch, "orch/T1");
        assert.equal(existsSync(created.worktree), true);
        assert.deepEqual(manager.create(repository, "T1"), created);
        assert.match(manager.list(repository), /orch\/T1/);

        writeFileSync(join(created.worktree, "result.txt"), "done\n");
        git(created.worktree, ["add", "result.txt"]);
        git(created.worktree, ["commit", "-q", "-m", "result"]);
        const merged = manager.merge(repository, created.branch, { noFf: true, noGpgSign: true });
        assert.equal(merged.ok, true);
        assert.equal(merged.conflict, false);
        assert.equal(existsSync(join(repository, "result.txt")), true);

        const missing = manager.merge(repository, "missing-branch");
        assert.equal(missing.ok, false);
        assert.equal(missing.conflict, false);

        manager.remove(repository, created.worktree, created.branch);
        assert.equal(existsSync(created.worktree), false);
        assert.throws(() => manager.create(root, "T2"), /Kein git-Repo/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
