import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const surfaceTest = fileURLToPath(new URL("./mcp-surface.test.mjs", import.meta.url));

function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("MCP golden provenance fails closed when a shallow checkout lacks the base blob", (t) => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "orch-provenance-"));
    const source = join(temp, "source");
    const checkout = join(temp, "checkout");
    t.after(() => rmSync(temp, { recursive: true, force: true }));

    for (const path of ["bundle/server.mjs", "tests/fixtures/mcp-surface.golden.json"]) {
        const destination = join(source, path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(root, path), destination);
    }
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "user.name", "MCP provenance test"]);
    git(source, ["config", "user.email", "mcp-provenance@example.invalid"]);
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "current snapshot"]);
    git(temp, ["clone", "--depth", "1", pathToFileURL(source).href, checkout]);

    assert.equal(git(checkout, ["rev-parse", "--is-shallow-repository"]), "true");
    assert.equal(git(checkout, ["rev-list", "--count", "HEAD"]), "1");

    const env = { ...process.env, ORCH_AUTO_UPDATE: "false" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
        "--test",
        "--test-name-pattern",
        "golden reference is provably derived",
        surfaceTest,
    ], {
        cwd: checkout,
        encoding: "utf8",
        env,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0, `missing base provenance unexpectedly passed:\n${output}`);
    assert.match(output, /base blob|git show/, `failure did not identify missing base provenance:\n${output}`);
});
