import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dumpSurface } from "./helpers/mcp-surface.mjs";

// Issue #32 contract guard for the central "no loss of function — the external
// MCP tool surface is unchanged" claim of the hexagonal refactor.
//
// tests/readme-contract.test.mjs only checks that the same *names* are
// registered; bundlecheck only asserts a tool count and that models_list runs.
// Neither proves the input schemas, descriptions, defaults or prompt arguments
// survived the decomposition. This test boots the committed bundle and compares
// its FULL surface (every tool's name+description+inputSchema, every prompt's
// name+description+arguments) against a golden fixture captured from the base
// branch (main) — so a changed default, a dropped schema field or a regressed
// prompt argument in any of the 17 tools fails the gate, not just a renamed tool.
//
// Regenerate the golden only when an intentional surface change is made:
//   git show origin/main:bundle/server.mjs > /tmp/base.mjs
//   node -e 'import("./tests/helpers/mcp-surface.mjs").then(async m => \
//     require("fs").writeFileSync("tests/fixtures/mcp-surface.golden.json", \
//     JSON.stringify(await m.dumpSurface("/tmp/base.mjs"), null, 2)+"\n"))'

const golden = JSON.parse(readFileSync("tests/fixtures/mcp-surface.golden.json", "utf8"));

test("the current bundle's MCP surface is byte-for-byte identical to the base branch", async () => {
    const current = await dumpSurface(process.cwd() + "/bundle/server.mjs");

    // Names + counts first (clear failure message), then the full contract.
    assert.deepEqual(
        current.tools.map((t) => t.name),
        golden.tools.map((t) => t.name),
        "tool set changed vs base",
    );
    assert.deepEqual(
        current.prompts.map((p) => p.name),
        golden.prompts.map((p) => p.name),
        "prompt set changed vs base",
    );

    for (const tool of golden.tools) {
        const got = current.tools.find((t) => t.name === tool.name);
        assert.deepEqual(got, tool, `tool '${tool.name}' surface (description/inputSchema) changed vs base`);
    }
    for (const prompt of golden.prompts) {
        const got = current.prompts.find((p) => p.name === prompt.name);
        assert.deepEqual(got, prompt, `prompt '${prompt.name}' surface (description/arguments) changed vs base`);
    }

    // Full structural equality as a backstop.
    assert.deepEqual(current, golden, "MCP surface diverged from the base-branch golden");
});
