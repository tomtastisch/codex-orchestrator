import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

test("package, lockfile and Claude plugin versions agree", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    const plugin = readJson(".claude-plugin/plugin.json");

    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(plugin.version, pkg.version);
});

test("npm test always builds ignored dist artifacts first", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.scripts.pretest, "npm run build");
});

test("bundle verification is part of the package scripts", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.scripts["verify:bundle"], "node scripts/verify-bundle.mjs");
    assert.equal(existsSync("scripts/verify-bundle.mjs"), true);
});
