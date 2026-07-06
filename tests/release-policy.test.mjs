import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const workflowPath = ".github/workflows/release.yml";

test("version changes on main publish and retain exactly one stable release", () => {
    assert.equal(existsSync(workflowPath), true, `${workflowPath} must exist`);
    const workflow = readFileSync(workflowPath, "utf8");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");

    for (const required of [
        "workflow_call",
        "group: codex-orchestrator-release",
        "contents: write",
        "npm run typecheck",
        "npm test",
        "npm run verify:bundle",
        "npm run mcpb:validate",
        "npm run mcpb:build",
        "npm run mcpb:verify",
        "npm run benchmark",
        "node scripts/bundlecheck.mjs",
        "plugin validate . --strict",
        "npm audit --audit-level=moderate",
        "gh release create",
        "gh release view",
        "gh release upload",
        "--clobber",
        "gh release delete",
        "--cleanup-tag",
        "git push origin \":refs/tags/$tag\"",
        "--latest",
        "release_count",
        "tag_count",
    ]) assert.ok(workflow.includes(required), `release workflow contract missing: ${required}`);

    assert.match(workflow, /previous_version[\s\S]*current_version/);
    assert.match(workflow, /if \[ "\$previous_version" = "\$current_version" \]/);
    assert.match(workflow, /remote_tag_sha[\s\S]*GITHUB_SHA/);
    assert.match(workflow, /if \[ "\$release_count" -ne 1 \] \|\| \[ "\$tag_count" -ne 1 \]/);
    assert.doesNotMatch(workflow, /git tag --list/);
    assert.match(ci, /release:[\s\S]*needs: \[test, remote-acceptance\]/);
    assert.match(ci, /release:[\s\S]*github\.event_name == 'push'/);
    assert.match(ci, /release:[\s\S]*contents: write/);
    assert.match(ci, /release:[\s\S]*uses: \.\/\.github\/workflows\/release\.yml/);
});
