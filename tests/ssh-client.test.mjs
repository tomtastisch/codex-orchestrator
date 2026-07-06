import { test } from "node:test";
import assert from "node:assert/strict";

test("SSH and SCP clients honor an explicit OpenSSH config file", async () => {
    const client = await import("../dist/execution/ssh/client.js");
    const options = { host: "loopback", configFile: "/tmp/isolated-ssh-config" };

    assert.deepEqual(client.sshOptions(options).slice(0, 2), ["-F", "/tmp/isolated-ssh-config"]);
    assert.deepEqual(client.scpOptions(options).slice(0, 2), ["-F", "/tmp/isolated-ssh-config"]);
});
