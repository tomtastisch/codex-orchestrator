import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("repository checks never inherit parent secrets", async () => {
    const runtime = await import("../dist/runtime/environment.js").catch(() => null);
    assert.ok(runtime, "runtime environment module must exist");

    const env = runtime.buildChildEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        LANG: "de_DE.UTF-8",
        OPENAI_API_KEY: "canary-openai",
        GITHUB_TOKEN: "canary-github",
        CLAUDE_CODE_OAUTH_TOKEN: "canary-claude",
        CODEX_HOME: "/tmp/codex-home",
    }, "repository-check");

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.LANG, "de_DE.UTF-8");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CODEX_HOME, undefined);
});

test("Codex receives its home but not unrelated connector secrets", async () => {
    const runtime = await import("../dist/runtime/environment.js").catch(() => null);
    assert.ok(runtime, "runtime environment module must exist");

    const env = runtime.buildChildEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        CODEX_HOME: "/tmp/codex-home",
        GITHUB_TOKEN: "canary-github",
    }, "codex");

    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.GITHUB_TOKEN, undefined);
});

test("redaction removes credential material and is idempotent", async () => {
    const runtime = await import("../dist/runtime/redaction.js").catch(() => null);
    assert.ok(runtime, "runtime redaction module must exist");

    const input = [
        "Authorization: Bearer canary-bearer",
        "OPENAI_API_KEY=canary-openai",
        "GITHUB_TOKEN: canary-github",
        "https://example.test/?access_token=canary-query&ok=1",
        "-----BEGIN PRIVATE KEY-----\ncanary-private\n-----END PRIVATE KEY-----",
    ].join("\n");
    const once = runtime.redact(input);
    const twice = runtime.redact(once);

    for (const secret of ["canary-bearer", "canary-openai", "canary-github", "canary-query", "canary-private"]) {
        assert.equal(once.includes(secret), false, secret);
    }
    assert.equal(twice, once);
});

test("unknown Codex extra_config keys are rejected", async () => {
    const codex = await import("../dist/codex.js");
    assert.throws(
        () => codex.buildCodexArgs({
            sandbox: "read-only",
            model: "gpt-5.5",
            effort: "medium",
            network: false,
            extraConfig: { future_unknown_key: "true" },
        }),
        /nicht erlaubt/,
    );
});

test("managed process escalates an ignored SIGTERM to SIGKILL", async () => {
    const runtime = await import("../dist/runtime/process.js").catch(() => null);
    assert.ok(runtime, "runtime process module must exist");

    const running = runtime.startManagedProcess({
        command: process.execPath,
        args: ["tests/fixtures/ignore-term.mjs"],
        cwd: process.cwd(),
        env: {},
        // Leave enough time for the child to install its SIGTERM handler even
        // when the complete test suite starts many Node processes in parallel.
        timeoutMs: 500,
        killGraceMs: 100,
        maxStdoutBytes: 8_192,
        maxStderrBytes: 8_192,
    });

    const result = await running.done;
    assert.equal(result.termination, "timeout");
    if (process.platform === "win32") assert.notEqual(result.signal, null);
    else assert.equal(result.signal, "SIGKILL");
});

test("managed process resolves JavaScript launchers without a shell on Windows", async () => {
    const runtime = await import("../dist/runtime/process.js");
    const fixture = "C:\\fixtures\\fake-codex.mjs";
    assert.deepEqual(
        runtime.resolveManagedCommand(fixture, ["--version"], "win32"),
        { command: process.execPath, args: [fixture, "--version"] },
    );
    assert.deepEqual(
        runtime.resolveManagedCommand("codex", ["--version"], "win32"),
        { command: "codex", args: ["--version"] },
    );
});

test("managed process owns a shell-free cross-platform executable resolver", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const source = readFileSync("src/runtime/process.ts", "utf8");

    assert.equal(pkg.dependencies["cross-spawn"], "^7.0.6");
    assert.match(source, /from "cross-spawn"/);
    assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test("managed process launches a Windows command shim by its bare name", {
    skip: process.platform !== "win32",
}, async () => {
    const runtime = await import("../dist/runtime/process.js");
    const directory = mkdtempSync(join(tmpdir(), "orch-windows-shim-"));
    try {
        writeFileSync(join(directory, "codex.cmd"), "@echo off\r\necho shim-ok\r\n", "utf8");
        const running = runtime.startManagedProcess({
            command: "codex",
            args: [],
            cwd: directory,
            env: {
                ...process.env,
                PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
            },
            timeoutMs: 5_000,
            killGraceMs: 100,
            maxStdoutBytes: 8_192,
            maxStderrBytes: 8_192,
        });

        const result = await running.done;
        assert.equal(result.termination, "normal");
        assert.equal(result.code, 0);
        assert.match(result.stdout, /shim-ok/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("merge eligibility requires confirmed cluster, review, checks and task ownership", async () => {
    const stateMachine = await import("../dist/statemachine.js");
    assert.equal(typeof stateMachine.mergeEligibility, "function");

    const base = {
        clusterId: "C1",
        taskClusterId: "C1",
        taskStatus: "completed",
        clusterStatus: "confirmed",
        reviewStatus: "confirmed",
        checksGreen: true,
    };
    assert.deepEqual(stateMachine.mergeEligibility(base), { ok: true, reasons: [] });
    assert.equal(stateMachine.mergeEligibility({ ...base, reviewStatus: "needs_changes" }).ok, false);
    assert.equal(stateMachine.mergeEligibility({ ...base, checksGreen: false }).ok, false);
    assert.equal(stateMachine.mergeEligibility({ ...base, taskClusterId: "C2" }).ok, false);
    assert.equal(stateMachine.mergeEligibility({ ...base, clusterStatus: "in_review" }).ok, false);
});
