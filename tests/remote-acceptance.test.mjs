import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("remote acceptance helpers fail closed on missing binaries", async () => {
    const helpers = await import("../scripts/lib/remote-acceptance.mjs");
    assert.throws(() => helpers.findBinary("definitely-not-installed", "/nonexistent"), /nicht gefunden|not found/i);
});

test("remote acceptance helpers allocate a non-privileged loopback port", async () => {
    const { allocateLoopbackPort } = await import("../scripts/lib/remote-acceptance.mjs");
    const port = await allocateLoopbackPort();
    assert.equal(Number.isInteger(port), true);
    assert.equal(port > 1024 && port <= 65535, true);
});

test("remote acceptance cleanup terminates children and removes its root", async () => {
    const { AcceptanceCleanup } = await import("../scripts/lib/remote-acceptance.mjs");
    const root = mkdtempSync(join(tmpdir(), "orch-acceptance-cleanup-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const cleanup = new AcceptanceCleanup(root);
    cleanup.track(child);

    await cleanup.run();

    assert.equal(existsSync(root), false);
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test("remote acceptance retries a readiness probe until it succeeds", async () => {
    const { retryUntilSuccess } = await import("../scripts/lib/remote-acceptance.mjs");
    let attempts = 0;
    const result = await retryUntilSuccess(async () => {
        attempts++;
        if (attempts < 3) throw new Error("not ready");
        return "ready";
    }, { attempts: 4, delayMs: 1 });

    assert.equal(result, "ready");
    assert.equal(attempts, 3);
});

test("remote acceptance resolves real auth before isolating the SSH client home", async () => {
    const { resolveCodexAuthSource } = await import("../scripts/lib/remote-acceptance.mjs");
    assert.equal(
        resolveCodexAuthSource({}, "/Users/tester"),
        join("/Users/tester", ".codex", "auth.json"),
    );
    assert.equal(
        resolveCodexAuthSource({ CODEX_HOME: "/secure/codex" }, "/Users/tester"),
        join("/secure/codex", "auth.json"),
    );
});
