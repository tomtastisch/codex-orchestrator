import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dumpSurface } from "./helpers/mcp-surface.mjs";

// Issue #32 contract guard for the central "no loss of function — the external
// MCP tool surface is unchanged" claim of the hexagonal refactor.
//
// tests/readme-contract.test.mjs only checks that the same *names* are
// registered; bundlecheck only asserts a tool count and that models_list runs.
// Neither proves the input schemas, descriptions, defaults or prompt arguments
// survived the decomposition. This test boots the committed bundle and compares
// its FULL surface (every tool's name+description+inputSchema, every prompt's
// name+description+arguments) against a reference captured from the BASE branch.
//
// Provenance (see the review on self-referential goldens): the fixture records
// the base commit SHA and the sha256 of the base bundle it was generated from.
// The provenance test below re-derives the reference from that exact base blob
// via `git show <base>:bundle/server.mjs` and asserts (a) the blob's digest
// matches, and (b) its surface equals the stored surface. A silent co-edit of
// code + golden is therefore impossible wherever git history is present: you
// cannot make the base bundle produce a changed surface. Regenerate the fixture
// only via scripts/gen-mcp-golden (documented in the PR), never by hand.

const fixture = JSON.parse(readFileSync("tests/fixtures/mcp-surface.golden.json", "utf8"));
const golden = fixture.surface;
const provenance = fixture.$provenance.base;

function baseBundle() {
    // Returns the base branch's bundle bytes, or null if the base blob is not
    // reachable (e.g. a shallow clone without the base commit).
    try {
        return execFileSync("git", ["show", `${provenance.commit}:${provenance.bundlePath}`], {
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    }
}

test("the current bundle's MCP surface is byte-for-byte identical to the base branch", async () => {
    const current = await dumpSurface(process.cwd() + "/bundle/server.mjs");

    assert.deepEqual(current.tools.map((t) => t.name), golden.tools.map((t) => t.name), "tool set changed vs base");
    assert.deepEqual(current.prompts.map((p) => p.name), golden.prompts.map((p) => p.name), "prompt set changed vs base");
    for (const tool of golden.tools) {
        const got = current.tools.find((t) => t.name === tool.name);
        assert.deepEqual(got, tool, `tool '${tool.name}' surface (description/inputSchema) changed vs base`);
    }
    for (const prompt of golden.prompts) {
        const got = current.prompts.find((p) => p.name === prompt.name);
        assert.deepEqual(got, prompt, `prompt '${prompt.name}' surface (description/arguments) changed vs base`);
    }
    assert.deepEqual(current, golden, "MCP surface diverged from the base-branch reference");
});

test("the golden reference is provably derived from the base bundle (not co-edited)", async () => {
    assert.match(provenance.commit ?? "", /^[0-9a-f]{40}$/, "fixture must record a full base commit SHA");
    assert.match(provenance.bundleSha256 ?? "", /^[0-9a-f]{64}$/, "fixture must record the base bundle sha256");

    const bytes = baseBundle();
    if (bytes === null) {
        // A shallow CI checkout may not have the base blob. The digest is still
        // pinned in the fixture; the parity test above remains a hard gate. We
        // don't silently pass off a missing check as verified — we assert the
        // provenance fields exist (done above) and skip only the git re-derivation.
        console.error(`[mcp-surface] base blob ${provenance.commit}:${provenance.bundlePath} unreachable; skipping git re-derivation (digest still pinned)`);
        return;
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, provenance.bundleSha256, "base bundle content does not match the recorded sha256 — fixture provenance is stale or forged");

    // Re-derive the surface from the base blob and prove it equals the stored
    // reference. This is what makes a silent code+golden co-edit impossible.
    const tmp = join(mkdtempSync(join(tmpdir(), "orch-base-")), "base-server.mjs");
    writeFileSync(tmp, bytes);
    const rederived = await dumpSurface(tmp);
    assert.deepEqual(rederived, golden, "the stored golden does not match the base bundle's actual surface");
});
