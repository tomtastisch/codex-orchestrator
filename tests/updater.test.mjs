import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("updater owns the same shell-free cross-platform executable resolver", () => {
    const source = readFileSync("src/updater.ts", "utf8");
    assert.match(source, /from "cross-spawn"/);
    assert.doesNotMatch(source, /from "node:child_process"/);
    assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test("Codex version parsing and semver ordering fail closed", async () => {
    const { installedVersion, isOlder } = await import("../dist/updater.js");
    assert.match(installedVersion(process.execPath), /^\d+\.\d+\.\d+/);
    assert.equal(installedVersion("definitely-missing-codex-binary"), null);
    assert.equal(isOlder("1.2.3", "1.2.4"), true);
    assert.equal(isOlder("1.2.3", "1.2.3"), false);
    assert.equal(isOlder("1.2.3-alpha", "1.2.3-beta"), true);
    assert.equal(isOlder("2.0.0", "1.99.99"), false);
    assert.equal(isOlder("1.2", "1.2.0"), true);
    assert.equal(isOlder("1.2.0", "1.2"), false);
});

test("disabled startup updates perform no discovery or installation", async () => {
    const original = process.env.ORCH_AUTO_UPDATE;
    process.env.ORCH_AUTO_UPDATE = "false";
    try {
        const { maybeAutoUpdate } = await import("../dist/updater.js");
        const messages = [];
        await maybeAutoUpdate((message) => messages.push(message));
        assert.deepEqual(messages, []);
    } finally {
        if (original === undefined) delete process.env.ORCH_AUTO_UPDATE;
        else process.env.ORCH_AUTO_UPDATE = original;
    }
});

test("Windows updater resolves PATH-based codex.cmd and npm.cmd shims", {
    skip: process.platform !== "win32",
}, async () => {
    const directory = mkdtempSync(join(tmpdir(), "orch-updater-shims-"));
    const originalPath = process.env.PATH;
    try {
        writeFileSync(join(directory, "codex.cmd"), "@echo off\r\necho codex-cli 1.2.3\r\n", "utf8");
        writeFileSync(join(directory, "npm.cmd"), [
            "@echo off",
            "if /I \"%~1\"==\"view\" goto view",
            "if /I \"%~1\"==\"install\" goto install",
            "exit /b 1",
            ":view",
            "echo 1.2.4",
            "exit /b 0",
            ":install",
            "echo installed",
            "exit /b 0",
            "",
        ].join("\r\n"), "utf8");
        process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
        const updater = await import("../dist/updater.js");

        assert.equal(updater.installedVersion("codex"), "1.2.3");
        assert.equal(updater.latestVersion("latest"), "1.2.4");
        assert.deepEqual(updater.checkForUpdate("latest", "codex"), {
            installed: "1.2.3",
            latest: "1.2.4",
            channel: "latest",
            updateAvailable: true,
        });
        assert.deepEqual(await updater.runUpdate("latest"), { ok: true, output: "installed\r\n" });
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(directory, { recursive: true, force: true });
    }
});
