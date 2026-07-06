import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fakeSsh = resolve("tests/fixtures/fake-ssh.mjs");
const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
const workerEntry = resolve("dist/worker/server.js");
chmodSync(fakeSsh, 0o755);
chmodSync(fakeCodex, 0o755);

function options() {
    return {
        id: "test-remote",
        host: "test-remote",
        localRoot: process.cwd(),
        remoteRoot: process.cwd(),
        codexBin: fakeCodex,
        codexHome: "~/.codex",
        sshBin: fakeSsh,
        workerEntry,
        skipDeploy: true,
    };
}

test("SSH target runs remote doctor through the worker protocol", async () => {
    const execution = await import("../dist/execution/ssh/target.js").catch(() => null);
    assert.ok(execution, "SSH target module must exist");
    const target = new execution.SshExecutionTarget(options());

    const health = await target.doctor();

    assert.equal(health.targetId, "test-remote");
    assert.equal(health.kind, "ssh");
    assert.equal(health.state, "healthy");
    assert.equal(health.auth.method, "chatgpt");
});

test("SSH target streams and returns a remote Codex slice", async () => {
    const { SshExecutionTarget } = await import("../dist/execution/ssh/target.js");
    const target = new SshExecutionTarget(options());
    const events = [];
    const running = target.startCodex({
        repoPath: process.cwd(),
        prompt: "test",
        sandbox: "read-only",
        model: "gpt-5.5",
        effort: "low",
        network: false,
        timeoutMs: 2_000,
        onLine: (line) => events.push(line),
    });
    const outcome = await running.done;

    assert.equal(outcome.status, "normal");
    assert.equal(outcome.threadId, "fake-thread");
    assert.equal(events.some((line) => line.includes("thread.started")), true);
});

test("SSH target maps only repositories under its configured local root", async () => {
    const { SshExecutionTarget } = await import("../dist/execution/ssh/target.js");
    const target = new SshExecutionTarget(options());

    assert.throws(() => target.mapRepository("/private/outside"), /außerhalb/);
    assert.equal(target.mapRepository(process.cwd()), process.cwd());
});

test("SSH target creates, merges and removes an isolated remote worktree", async () => {
    const { SshExecutionTarget } = await import("../dist/execution/ssh/target.js");
    const root = mkdtempSync(join(tmpdir(), "orch-remote-worktree-"));
    const repository = join(root, "repo");
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repository, "base.txt"), "base\n");
    execFileSync("git", ["-C", repository, "add", "base.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "base"]);
    const target = new SshExecutionTarget({ ...options(), localRoot: root, remoteRoot: root });

    const created = await target.createWorktree(repository, "T_test");
    assert.equal(existsSync(created.worktree), true);
    writeFileSync(join(created.worktree, "remote.txt"), "remote\n");
    execFileSync("git", ["-C", created.worktree, "add", "remote.txt"]);
    execFileSync("git", ["-C", created.worktree, "commit", "-qm", "remote"]);

    const merged = await target.mergeWorktree(repository, created.branch, { noFf: true, noGpgSign: true });
    assert.equal(merged.ok, true);
    assert.equal(existsSync(join(repository, "remote.txt")), true);
    await target.removeWorktree(repository, created.worktree, created.branch);
    assert.equal(existsSync(created.worktree), false);
});
