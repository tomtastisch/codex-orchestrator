import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
chmodSync(fakeCodex, 0o755);

test("worker handshake exposes protocol without environment or credentials", async () => {
    const worker = await import("../dist/worker/operations.js").catch(() => null);
    assert.ok(worker, "worker operations module must exist");

    const result = await worker.executeWorkerRequest({
        requestId: randomUUID(), protocol: 1, operation: "handshake",
    });

    assert.equal(result.protocol, 1);
    assert.equal(typeof result.workerVersion, "string");
    assert.equal(JSON.stringify(result).includes("OPENAI_API_KEY"), false);
});

test("worker doctor uses the remote Codex binary", async () => {
    const { executeWorkerRequest } = await import("../dist/worker/operations.js");
    const result = await executeWorkerRequest({
        requestId: randomUUID(), protocol: 1, operation: "doctor", codexBin: fakeCodex,
    });

    assert.equal(result.state, "healthy");
    assert.equal(result.auth.method, "chatgpt");
});

test("worker auth bootstrap writes bytes atomically with private permissions", async () => {
    const { executeWorkerRequest } = await import("../dist/worker/operations.js");
    const directory = mkdtempSync(join(tmpdir(), "orch-auth-"));
    const secret = Buffer.from("synthetic-canary-credential");
    const request = {
        requestId: randomUUID(),
        protocol: 1,
        operation: "auth.bootstrap",
        codexHome: directory,
        credentialBase64: secret.toString("base64"),
    };

    const first = await executeWorkerRequest(request);
    const authPath = join(directory, "auth.json");
    assert.equal(first.state, "installed");
    assert.deepEqual(readFileSync(authPath), secret);
    if (process.platform !== "win32") assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(first).includes("synthetic-canary"), false);

    const second = await executeWorkerRequest({ ...request, requestId: randomUUID() });
    assert.equal(second.state, "already_present");
    assert.deepEqual(readFileSync(authPath), secret);

    const refreshed = Buffer.from("refreshed-synthetic-credential");
    const third = await executeWorkerRequest({
        ...request,
        requestId: randomUUID(),
        credentialBase64: refreshed.toString("base64"),
    });
    assert.equal(third.state, "updated");
    assert.deepEqual(readFileSync(authPath), refreshed);
});

test("worker passes an access token only through Codex stdin", async () => {
    const { executeWorkerRequest } = await import("../dist/worker/operations.js");
    const directory = mkdtempSync(join(tmpdir(), "orch-token-login-"));
    const token = Buffer.from("synthetic-access-token");

    const result = await executeWorkerRequest({
        requestId: randomUUID(),
        protocol: 1,
        operation: "auth.login-token",
        codexBin: fakeCodex,
        codexHome: directory,
        tokenBase64: token.toString("base64"),
    });

    assert.deepEqual(result, { state: "installed" });
    assert.equal(JSON.stringify(result).includes("synthetic-access-token"), false);
});

test("worker streams and returns a Codex slice", async () => {
    const { executeWorkerRequest } = await import("../dist/worker/operations.js");
    const events = [];
    const result = await executeWorkerRequest({
        requestId: randomUUID(),
        protocol: 1,
        operation: "codex.run",
        allowedRoot: process.cwd(),
        cwd: process.cwd(),
        codexBin: fakeCodex,
        options: {
            prompt: "test",
            sandbox: "read-only",
            model: "gpt-5.5",
            effort: "low",
            network: false,
            timeoutMs: 2_000,
        },
    }, (line) => events.push(line));

    assert.equal(result.status, "normal");
    assert.equal(result.threadId, "fake-thread");
    assert.equal(events.some((line) => line.includes("thread.started")), true);
});
