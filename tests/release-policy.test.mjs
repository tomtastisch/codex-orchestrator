import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const workflowPath = ".github/workflows/release.yml";

/**
 * Return one top-level workflow job without allowing matches in later jobs.
 *
 * @param {string} workflow complete workflow source
 * @param {string} jobName exact job identifier
 * @returns {string} isolated job source
 */
function workflowJob(workflow, jobName) {
    const header = `  ${jobName}:\n`;
    const start = workflow.indexOf(header);
    assert.notEqual(start, -1, `workflow job missing: ${jobName}`);
    const bodyStart = start + header.length;
    const remaining = workflow.slice(bodyStart);
    const nextJobOffset = remaining.search(/^  [A-Za-z0-9_-]+:\n/m);
    const end = nextJobOffset === -1 ? workflow.length : bodyStart + nextJobOffset;
    return workflow.slice(start, end);
}

test("version changes on main publish and retain exactly one stable release", () => {
    assert.equal(existsSync(workflowPath), true, `${workflowPath} must exist`);
    const workflow = readFileSync(workflowPath, "utf8");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");

    for (const required of [
        "workflow_call",
        "group: codex-orchestrator-release",
        "contents: write",
        'node-version: ">=22.5.0 <23"',
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
        "mode=publish",
        "mode=cleanup",
        "mode=noop",
        "current_release_exists",
        "current_tag_exists",
        "release_count",
        "tag_count",
    ]) assert.ok(workflow.includes(required), `release workflow contract missing: ${required}`);

    assert.doesNotMatch(workflow, /HEAD\^:package\.json/);
    assert.doesNotMatch(workflow, /outputs\.changed/);
    assert.match(workflow, /current_tag_exists[\s\S]*current_release_exists[\s\S]*release_count[\s\S]*tag_count/);
    assert.match(workflow, /if \[ "\$current_tag_exists" = true \] && \[ "\$current_release_exists" = true \]/);
    assert.match(workflow, /while true; do[\s\S]*removed_release=false[\s\S]*gh release delete[\s\S]*\[ "\$removed_release" = false \] && break/);
    assert.match(workflow, /remote_tag_sha[\s\S]*GITHUB_SHA/);
    assert.match(workflow, /tag_count=\$\(git ls-remote --tags --refs origin 'refs\/tags\/v\*'/);
    assert.match(workflow, /remote_tag=\$\(git ls-remote --tags --refs origin "refs\/tags\/\$CURRENT_TAG"/);
    assert.match(workflow, /if \[ "\$release_count" -ne 1 \] \|\| \[ "\$tag_count" -ne 1 \]/);
    assert.doesNotMatch(workflow, /git tag --list/);
    assert.doesNotMatch(workflow, /\[\[ "\$tag" =~/);
    assert.doesNotMatch(workflow, /node-version: "22"/);
    assert.match(ci, /release:[\s\S]*needs: \[test, remote-acceptance\]/);
    assert.match(ci, /release:[\s\S]*github\.event_name == 'push'/);
    assert.match(ci, /release:[\s\S]*contents: write/);
    assert.match(ci, /release:[\s\S]*uses: \.\/\.github\/workflows\/release\.yml/);
});

test("workflows use the current supported action majors", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = readFileSync(workflowPath, "utf8");
    const workflows = `${ci}\n${release}`;
    const remoteAcceptance = workflowJob(ci, "remote-acceptance");

    assert.match(ci, /actions\/checkout@v7/);
    assert.match(ci, /actions\/setup-node@v6/);
    assert.match(release, /actions\/checkout@v7/);
    assert.match(release, /actions\/setup-node@v6/);
    assert.doesNotMatch(workflows, /actions\/(?:checkout|setup-node)@v4/);
    assert.match(remoteAcceptance, /^    runs-on: macos-15$/m);
    assert.doesNotMatch(ci, /runs-on: macos-latest/);
});
