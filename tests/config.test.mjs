import { test } from "node:test";
import assert from "node:assert/strict";

test("execution config defaults to local-only", async () => {
    const config = await import("../dist/config-schema.js").catch(() => null);
    assert.ok(config, "config schema module must exist");
    assert.deepEqual(config.parseExecutionConfig({}), {
        version: 1,
        execution: { mode: "local-only", fallback: "never" },
    });
});

test("remote-preferred requires a strict SSH target", async () => {
    const { parseExecutionConfig } = await import("../dist/config-schema.js");
    assert.throws(
        () => parseExecutionConfig({ version: 1, execution: { mode: "remote-preferred" } }),
        /remote/,
    );
    assert.throws(
        () => parseExecutionConfig({
            version: 1,
            execution: {
                mode: "remote-preferred",
                fallback: "connectivity-only",
                remote: {
                    id: "devbox",
                    transport: "ssh",
                    host: "devbox;rm",
                    repository: { localRoot: "/local", remoteRoot: "/remote" },
                    auth: { strategy: "existing" },
                },
            },
        }),
        /host/,
    );
});

test("execution config rejects inline secrets and unknown fields", async () => {
    const { parseExecutionConfig } = await import("../dist/config-schema.js");
    assert.throws(
        () => parseExecutionConfig({
            version: 1,
            execution: { mode: "local-only", fallback: "never", token: "canary" },
        }),
        /Unrecognized key|token/,
    );
});

test("positive integer environment values fail closed", async () => {
    const { parsePositiveInteger } = await import("../dist/config-schema.js");
    assert.equal(parsePositiveInteger("2", "ORCH_MAX_CONCURRENT"), 2);
    for (const invalid of ["0", "-1", "NaN", "1.5", ""] ) {
        assert.throws(() => parsePositiveInteger(invalid, "ORCH_MAX_CONCURRENT"), /ORCH_MAX_CONCURRENT/);
    }
});

test("runtime config exposes the validated execution policy", async () => {
    const { config } = await import("../dist/config.js");
    assert.equal(config.execution.mode, "local-only");
    assert.equal(config.execution.fallback, "never");
});
