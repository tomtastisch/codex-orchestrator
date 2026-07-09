import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("executor instructions are created, preserved and appended deterministically", async () => {
    const home = mkdtempSync(join(tmpdir(), "orch-agents-home-"));
    const originalHome = process.env.ORCH_HOME;
    process.env.ORCH_HOME = home;
    try {
        const { centralAgentsMd, ensureAgentsMd } = await import("../dist/agents.js");
        const central = centralAgentsMd();
        assert.equal(central, join(home, "AGENTS.md"));
        assert.match(readFileSync(central, "utf8"), /codex-orchestrator/);

        const createdDirectory = join(home, "created");
        const created = ensureAgentsMd(createdDirectory);
        assert.equal(created.action, "created");
        assert.match(readFileSync(created.path, "utf8"), /SLICE_RESULT/);

        const present = ensureAgentsMd(createdDirectory);
        assert.deepEqual(present, { path: created.path, action: "present" });

        const appendedDirectory = join(home, "appended");
        const existing = ensureAgentsMd(appendedDirectory);
        writeFileSync(existing.path, "# Project instructions\n", "utf8");
        const appended = ensureAgentsMd(appendedDirectory);
        assert.equal(appended.action, "appended");
        const combined = readFileSync(appended.path, "utf8");
        assert.match(combined, /^# Project instructions/m);
        assert.match(combined, /codex-orchestrator/);
    } finally {
        if (originalHome === undefined) delete process.env.ORCH_HOME;
        else process.env.ORCH_HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    }
});
