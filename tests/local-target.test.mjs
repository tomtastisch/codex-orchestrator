import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";

const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
chmodSync(fakeCodex, 0o755);

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
