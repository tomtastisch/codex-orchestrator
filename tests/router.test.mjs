import { test } from "node:test";
import assert from "node:assert/strict";

function target(id, kind, options = {}) {
    return {
        id,
        kind,
        async doctor() {
            if (options.doctorError) throw options.doctorError;
            return options.health ?? {
                targetId: id,
                kind,
                state: "healthy",
                codexVersion: "1.0.0",
                auth: { state: "authenticated", method: "chatgpt", message: "ok" },
                message: "ok",
            };
        },
        async repositoryIdentity() {
            return options.identity ?? { topLevel: "/repo", headCommit: "abc123", clean: true };
        },
        startCodex() { throw new Error("not used"); },
        async runCheck() { throw new Error("not used"); },
        async runGit() { throw new Error("not used"); },
    };
}

test("router selects a healthy matching remote target", async () => {
    const { ExecutionTargetRouter } = await import("../dist/execution/router.js").catch(() => ({}));
    assert.equal(typeof ExecutionTargetRouter, "function");
    const router = new ExecutionTargetRouter({
        mode: "remote-preferred",
        fallback: "connectivity-only",
        local: target("local", "local"),
        remote: target("remote", "ssh"),
    });

    const selection = await router.select("/repo");

    assert.equal(selection.target.id, "remote");
    assert.equal(selection.reason, "remote-healthy");
    assert.equal(selection.repository.headCommit, "abc123");
});

test("router falls back locally only for retryable connectivity errors", async () => {
    const { ExecutionTargetRouter } = await import("../dist/execution/router.js");
    const { TargetError } = await import("../dist/execution/errors.js");
    const router = new ExecutionTargetRouter({
        mode: "remote-preferred",
        fallback: "connectivity-only",
        local: target("local", "local"),
        remote: target("remote", "ssh", {
            doctorError: new TargetError("TARGET_CONNECTIVITY", "offline", "remote", true),
        }),
    });

    const selection = await router.select("/repo");

    assert.equal(selection.target.id, "local");
    assert.equal(selection.fallbackFrom, "remote");
    assert.equal(selection.reason, "remote-connectivity-fallback");
});

test("router never falls back for authentication or host-key failures", async () => {
    const { ExecutionTargetRouter } = await import("../dist/execution/router.js");
    const { TargetError } = await import("../dist/execution/errors.js");
    for (const code of ["TARGET_AUTH", "TARGET_HOST_KEY", "TARGET_VERSION"]) {
        const router = new ExecutionTargetRouter({
            mode: "remote-preferred",
            fallback: "connectivity-only",
            local: target("local", "local"),
            remote: target("remote", "ssh", { doctorError: new TargetError(code, "blocked", "remote") }),
        });
        await assert.rejects(() => router.select("/repo"), (error) => error.code === code);
    }
});

test("router blocks mismatching repository commits", async () => {
    const { ExecutionTargetRouter } = await import("../dist/execution/router.js");
    const router = new ExecutionTargetRouter({
        mode: "remote-preferred",
        fallback: "connectivity-only",
        local: target("local", "local", { identity: { topLevel: "/repo", headCommit: "local", clean: true } }),
        remote: target("remote", "ssh", { identity: { topLevel: "/repo", headCommit: "remote", clean: true } }),
    });

    await assert.rejects(
        () => router.select("/repo"),
        (error) => error.code === "TARGET_REPOSITORY",
    );
});
