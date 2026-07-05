import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("credential source accepts only a private regular file", async () => {
    const auth = await import("../dist/auth/bootstrap.js").catch(() => null);
    assert.ok(auth, "auth bootstrap module must exist");
    const directory = mkdtempSync(join(tmpdir(), "orch-auth-source-"));
    const source = join(directory, "auth.json");
    writeFileSync(source, "synthetic-credential", { mode: 0o600 });

    assert.equal(auth.loadCredentialFile(source).toString(), "synthetic-credential");

    if (process.platform !== "win32") {
        chmodSync(source, 0o644);
        assert.throws(() => auth.loadCredentialFile(source), /0600|Rechte/);
        chmodSync(source, 0o600);
    }
    const link = join(directory, "auth-link.json");
    symlinkSync(source, link);
    assert.throws(() => auth.loadCredentialFile(link), /reguläre Datei|Symlink/);
});

test("sync-file bootstrap is followed by a fresh remote auth check", async () => {
    const { RemoteAuthBootstrapper } = await import("../dist/auth/bootstrap.js");
    const directory = mkdtempSync(join(tmpdir(), "orch-auth-bootstrap-"));
    const source = join(directory, "auth.json");
    writeFileSync(source, "synthetic-credential", { mode: 0o600 });
    let authenticated = false;
    let received;
    const target = {
        id: "remote",
        async doctor() {
            return {
                targetId: "remote", kind: "ssh",
                state: authenticated ? "healthy" : "unhealthy",
                codexVersion: "1",
                auth: authenticated
                    ? { state: "authenticated", method: "chatgpt", message: "ok" }
                    : { state: "unauthenticated", message: "missing" },
                message: authenticated ? "ok" : "missing",
            };
        },
        async bootstrapAuth(_home, bytes) {
            received = bytes;
            authenticated = true;
            return { state: "installed" };
        },
    };
    const bootstrapper = new RemoteAuthBootstrapper();

    const health = await bootstrapper.ensure(target, {
        strategy: "sync-file", source, codexHome: "/remote/.codex",
    });

    assert.equal(health.state, "healthy");
    assert.equal(received.toString(), "synthetic-credential");
    assert.equal(JSON.stringify(health).includes("synthetic-credential"), false);
});

test("existing strategy fails closed when remote auth is missing", async () => {
    const { RemoteAuthBootstrapper } = await import("../dist/auth/bootstrap.js");
    const bootstrapper = new RemoteAuthBootstrapper();
    const target = {
        id: "remote",
        async doctor() {
            return {
                targetId: "remote", kind: "ssh", state: "unhealthy", codexVersion: "1",
                auth: { state: "unauthenticated", message: "missing" }, message: "missing",
            };
        },
    };

    await assert.rejects(
        () => bootstrapper.ensure(target, { strategy: "existing" }),
        (error) => error.code === "TARGET_AUTH",
    );
});

test("access-token strategy reads a secret command without persisting or returning the token", async () => {
    const { RemoteAuthBootstrapper } = await import("../dist/auth/bootstrap.js");
    let authenticated = false;
    let received;
    const target = {
        id: "remote",
        async doctor() {
            return {
                targetId: "remote", kind: "ssh", state: authenticated ? "healthy" : "unhealthy",
                codexVersion: "1",
                auth: authenticated
                    ? { state: "authenticated", method: "access-token", message: "ok" }
                    : { state: "unauthenticated", message: "missing" },
                message: authenticated ? "ok" : "missing",
            };
        },
        async loginAccessToken(_home, token) {
            received = Buffer.from(token);
            authenticated = true;
            return { state: "installed" };
        },
    };

    const health = await new RemoteAuthBootstrapper().ensure(target, {
        strategy: "access-token",
        secretCommand: [process.execPath, "-e", "process.stdout.write('synthetic-token\\n')"],
        codexHome: "/remote/.codex",
    });

    assert.equal(received.toString(), "synthetic-token");
    assert.equal(JSON.stringify(health).includes("synthetic-token"), false);
});
