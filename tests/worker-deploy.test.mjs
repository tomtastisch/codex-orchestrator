import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const command = resolve("tests/fixtures/fake-deploy-command.mjs");

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "orch-worker-deploy-"));
    const bundle = join(root, "worker.mjs");
    const bytes = "export {};\n";
    writeFileSync(bundle, bytes, "utf8");
    return { root, bundle, bytes };
}

function deployer(WorkerDeployer, bundle, host, workerRoot = "~/.cache/orchestrator") {
    return new WorkerDeployer({
        host,
        workerBundlePath: bundle,
        workerRoot,
        sshBin: command,
        scpBin: command,
        connectTimeoutSeconds: 1,
    });
}

test("worker deployer rejects missing bundles and unsafe remote roots", async () => {
    const { WorkerDeployer } = await import("../dist/execution/ssh/deploy.js");
    const { root, bundle } = fixture();
    try {
        await assert.rejects(
            deployer(WorkerDeployer, join(root, "missing.mjs"), "present-host").ensure(),
            (error) => error.code === "TARGET_VERSION",
        );
        await assert.rejects(
            deployer(WorkerDeployer, bundle, "present-host", "../escape").ensure(),
            (error) => error.code === "TARGET_POLICY",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("worker deployer reuses an existing immutable worker", async () => {
    const { WorkerDeployer } = await import("../dist/execution/ssh/deploy.js");
    const { root, bundle, bytes } = fixture();
    try {
        const hash = createHash("sha256").update(bytes).digest("hex");
        const destination = await deployer(WorkerDeployer, bundle, "present-host").ensure();
        assert.match(destination, new RegExp(`${hash}/worker\\.mjs$`));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("worker deployer creates, uploads and atomically activates a missing worker", async () => {
    const { WorkerDeployer } = await import("../dist/execution/ssh/deploy.js");
    const { root, bundle, bytes } = fixture();
    try {
        const hash = createHash("sha256").update(bytes).digest("hex");
        const destination = await deployer(WorkerDeployer, bundle, "missing-host").ensure();
        assert.match(destination, new RegExp(`${hash}/worker\\.mjs$`));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const [host, message] of [
    ["mkdir-fail-host", /Worker-Verzeichnis nicht erstellbar/],
    ["copy-fail-host", /Worker-Upload fehlgeschlagen/],
    ["activate-fail-host", /Worker-Aktivierung fehlgeschlagen/],
]) {
    test(`worker deployer reports ${host} as retryable connectivity failure`, async () => {
        const { WorkerDeployer } = await import("../dist/execution/ssh/deploy.js");
        const { root, bundle } = fixture();
        try {
            await assert.rejects(
                deployer(WorkerDeployer, bundle, host).ensure(),
                (error) => error.code === "TARGET_CONNECTIVITY" && error.retryable && message.test(error.message),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}
