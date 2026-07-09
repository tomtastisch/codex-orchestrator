import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("worker protocol accepts a strict handshake and rejects unknown operations", async () => {
    const protocol = await import("../dist/execution/ssh/protocol.js").catch(() => null);
    assert.ok(protocol, "SSH protocol module must exist");

    const handshake = protocol.parseWorkerRequest({
        requestId: randomUUID(),
        protocol: 1,
        operation: "handshake",
    });
    assert.equal(handshake.operation, "handshake");

    assert.throws(
        () => protocol.parseWorkerRequest({ requestId: randomUUID(), protocol: 1, operation: "shell.exec" }),
        /Invalid|operation/,
    );
    assert.throws(
        () => protocol.parseWorkerRequest({
            requestId: randomUUID(), protocol: 1, operation: "handshake", token: "canary",
        }),
        /Unrecognized key|token/,
    );
});

test("worker protocol constrains repository operations to an allowed root", async () => {
    const { parseWorkerRequest } = await import("../dist/execution/ssh/protocol.js");
    assert.throws(
        () => parseWorkerRequest({
            requestId: randomUUID(),
            protocol: 1,
            operation: "repository.identity",
            allowedRoot: "/srv/project",
            cwd: "/srv/project/../secret",
        }),
        /cwd|root|relative/,
    );
});

test("worker protocol rejects arbitrary check names and git subcommands", async () => {
    const { parseWorkerRequest } = await import("../dist/execution/ssh/protocol.js");
    assert.throws(
        () => parseWorkerRequest({
            requestId: randomUUID(), protocol: 1, operation: "check.run",
            allowedRoot: "/srv/project", cwd: "/srv/project", checkName: "shell",
        }),
        /checkName/,
    );
    assert.throws(
        () => parseWorkerRequest({
            requestId: randomUUID(), protocol: 1, operation: "git.run",
            allowedRoot: "/srv/project", cwd: "/srv/project", args: ["config", "--global", "x", "y"],
        }),
        /args|Git/,
    );
});

test("worker protocol requires an explicit Codex home for Codex operations", async () => {
    const { parseWorkerRequest } = await import("../dist/execution/ssh/protocol.js");
    assert.throws(() => parseWorkerRequest({
        requestId: randomUUID(), protocol: 1, operation: "doctor", codexBin: "/bin/codex",
    }), /codexHome/);
    const doctor = parseWorkerRequest({
        requestId: randomUUID(), protocol: 1, operation: "doctor",
        codexBin: "/bin/codex", codexHome: "/srv/codex-home",
    });
    assert.equal(doctor.codexHome, "/srv/codex-home");

    const base = {
        requestId: randomUUID(), protocol: 1, operation: "codex.run",
        allowedRoot: "/srv/project", cwd: "/srv/project", codexBin: "/bin/codex",
        options: {
            prompt: "test", sandbox: "read-only", model: "gpt-5.5",
            effort: "low", network: false, timeoutMs: 2_000,
        },
    };
    assert.throws(() => parseWorkerRequest(base), /codexHome/);
    assert.equal(parseWorkerRequest({ ...base, codexHome: "~/.codex" }).codexHome, "~/.codex");
    const nativeHome = join(tmpdir(), "codex-home");
    assert.equal(parseWorkerRequest({ ...base, codexHome: nativeHome }).codexHome, nativeHome);
    assert.throws(() => parseWorkerRequest({ ...base, codexHome: `${nativeHome}/../escape` }), /traversal/);
});
