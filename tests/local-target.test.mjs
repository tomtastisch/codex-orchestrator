import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
const statefulFakeCodex = resolve("tests/fixtures/stateful-fake-codex.mjs");
chmodSync(fakeCodex, 0o755);
chmodSync(statefulFakeCodex, 0o755);

test("local target reports Codex installation and ChatGPT authentication", async () => {
    const execution = await import("../dist/execution/local-target.js").catch(() => null);
    assert.ok(execution, "local execution target module must exist");

    const target = new execution.LocalExecutionTarget({ codexBin: fakeCodex });
    const health = await target.doctor();

    assert.equal(health.state, "healthy");
    assert.equal(health.codexVersion, "9.9.9");
    assert.equal(health.auth.state, "authenticated");
    assert.equal(health.auth.method, "chatgpt");
});

test("local target executes and parses a Codex slice", async () => {
    const { LocalExecutionTarget } = await import("../dist/execution/local-target.js");
    const target = new LocalExecutionTarget({ codexBin: fakeCodex });
    const running = target.startCodex({
        repoPath: process.cwd(),
        prompt: "test",
        sandbox: "read-only",
        model: "gpt-5.5",
        effort: "low",
        network: false,
        timeoutMs: 2_000,
    });
    const outcome = await running.done;

    assert.equal(outcome.status, "normal");
    assert.equal(outcome.threadId, "fake-thread");
    assert.equal(outcome.sliceResult.type, "submission");
});

test("local target uses its explicit Codex home for doctor and slices", async () => {
    const { LocalExecutionTarget } = await import("../dist/execution/local-target.js");
    const codexHome = mkdtempSync(join(tmpdir(), "orch-explicit-codex-home-"));
    const unrelatedHome = mkdtempSync(join(tmpdir(), "orch-unrelated-codex-home-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = unrelatedHome;
    try {
        const target = new LocalExecutionTarget({ codexBin: statefulFakeCodex, codexHome });
        assert.equal((await target.doctor()).state, "unhealthy");
        writeFileSync(join(codexHome, "auth.json"), "synthetic", { mode: 0o600 });
        assert.equal((await target.doctor()).state, "healthy");

        const outcome = await target.startCodex({
            repoPath: process.cwd(),
            prompt: "test",
            sandbox: "read-only",
            model: "gpt-5.5",
            effort: "low",
            network: false,
            timeoutMs: 2_000,
        }).done;
        assert.equal(outcome.status, "normal");
        assert.equal(outcome.threadId, "stateful-thread");
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
    }
});
