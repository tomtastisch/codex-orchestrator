import { test } from "node:test";
import assert from "node:assert/strict";

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
