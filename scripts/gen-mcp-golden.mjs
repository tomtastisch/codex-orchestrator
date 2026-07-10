// Regenerates tests/fixtures/mcp-surface.golden.json from the base branch's
// committed bundle. Run this ONLY when an intentional MCP-surface change is made
// and the base has advanced:
//
//   node scripts/gen-mcp-golden.mjs [base-ref]   # default base-ref: origin/main
//
// It records the base commit SHA and the base bundle's sha256 alongside the
// surface, so tests/mcp-surface.test.mjs can prove the golden was derived from
// that exact base bundle (never silently co-edited with a code change).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpSurface } from "../tests/helpers/mcp-surface.mjs";

const ref = process.argv[2] ?? "origin/main";
const commit = execFileSync("git", ["rev-parse", ref]).toString().trim();
const bundlePath = "bundle/server.mjs";
const bytes = execFileSync("git", ["show", `${commit}:${bundlePath}`], { maxBuffer: 64 * 1024 * 1024 });
const bundleSha256 = createHash("sha256").update(bytes).digest("hex");

const tmp = join(mkdtempSync(join(tmpdir(), "orch-golden-")), "base-server.mjs");
writeFileSync(tmp, bytes);
const surface = await dumpSurface(tmp);

const fixture = {
    $provenance: {
        note: "Reference MCP surface captured from the base branch bundle. base.commit + base.bundleSha256 pin the exact source; tests/mcp-surface.test.mjs verifies the surface was produced from THAT bundle (via git show) so code and golden cannot be silently co-edited.",
        base: { ref, commit, bundlePath, bundleSha256 },
    },
    surface,
};
writeFileSync("tests/fixtures/mcp-surface.golden.json", JSON.stringify(fixture, null, 2) + "\n");
console.log(`golden regenerated from ${ref} (${commit.slice(0, 12)}): ${surface.tools.length} tools, ${surface.prompts.length} prompts`);
