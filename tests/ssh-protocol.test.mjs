import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
