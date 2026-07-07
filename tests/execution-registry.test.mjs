import { test } from "node:test";
import assert from "node:assert/strict";

test("execution target registry owns lookup and unknown-target failures", async () => {
    const { ExecutionTargetRegistry } = await import("../dist/execution/registry.js");
    const registry = new ExecutionTargetRegistry();
    const target = { id: "fake", kind: "local" };
    registry.register(target);
    assert.equal(registry.get("fake"), target);
    assert.deepEqual(registry.list(), [target]);
    assert.throws(() => registry.get("missing"), /Unbekanntes Execution-Target/);
});

test("execution runtime registers local-only and authenticated remote targets", async () => {
    const { createExecutionRuntime } = await import("../dist/execution/registry.js");
    const local = createExecutionRuntime({
        codexBin: process.execPath,
        execution: { mode: "local-only", fallback: "never" },
    });
    assert.deepEqual(local.registry.list().map(({ id, kind }) => ({ id, kind })), [
        { id: "local", kind: "local" },
    ]);

    const remote = createExecutionRuntime({
        codexBin: process.execPath,
        execution: {
            mode: "remote-preferred",
            fallback: "connectivity-only",
            remote: {
                id: "review-host",
                host: "review-host",
                repository: { localRoot: "/local", remoteRoot: "/remote" },
                codexBin: "codex",
                codexHome: "~/.codex",
                workerRoot: "~/.cache/codex-orchestrator/workers",
                auth: { strategy: "existing" },
            },
        },
    });
    assert.deepEqual(remote.registry.list().map(({ id, kind }) => ({ id, kind })), [
        { id: "local", kind: "local" },
        { id: "review-host", kind: "ssh" },
    ]);
    assert.equal(remote.registry.get("review-host").id, "review-host");
});
