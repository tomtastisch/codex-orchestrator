import { test } from "node:test";
import assert from "node:assert/strict";

test("declared checks persist redacted results and reject unknown names", async () => {
    const { runChecks } = await import("../dist/checks.js");
    const persisted = [];
    const store = {
        addCheck(clusterId, name, exitCode, summary) {
            persisted.push({ clusterId, name, exitCode, summary });
        },
    };
    const target = {
        async runCheck({ argv }) {
            if (argv.includes("typecheck")) {
                return { code: 1, signal: null, stdout: "", stderr: "OPENAI_API_KEY=canary-secret\nfailed\n" };
            }
            return { code: 0, signal: null, stdout: "clean\n", stderr: "" };
        },
    };

    const result = await runChecks(
        store,
        "C1",
        "/repo",
        ["git_status", "typecheck", "unknown-check"],
        target,
    );

    assert.equal(result.allGreen, false);
    assert.deepEqual(result.unknown, ["unknown-check"]);
    assert.deepEqual(result.runs.map(({ name, ok }) => ({ name, ok })), [
        { name: "git_status", ok: true },
        { name: "typecheck", ok: false },
    ]);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[1].summary.includes("canary-secret"), false);
    assert.match(persisted[1].summary, /«redacted»/);
});

test("empty declared checks never count as green", async () => {
    const { runChecks } = await import("../dist/checks.js");
    const result = await runChecks({ addCheck() {} }, "C1", "/repo", [], {
        async runCheck() {
            throw new Error("must not run");
        },
    });
    assert.deepEqual(result, { runs: [], allGreen: false, unknown: [] });
});

test("diff size counts tracked, binary and untracked files", async () => {
    const { diffSize } = await import("../dist/checks.js");
    const calls = [];
    const target = {
        async runGit({ argv }) {
            calls.push(argv);
            if (argv[0] === "diff" && argv[1] === "--numstat" && argv[2] === "HEAD") {
                return { code: 0, signal: null, stdout: "3\t2\tsrc/a.ts\n-\t-\timage.bin\n", stderr: "" };
            }
            if (argv[0] === "ls-files") {
                return { code: 0, signal: null, stdout: "new.txt\n\n", stderr: "" };
            }
            return { code: 1, signal: null, stdout: "4\t0\t/dev/null => new.txt\n", stderr: "" };
        },
    };

    assert.deepEqual(await diffSize("/repo", target), { files: 3, lines: 9 });
    assert.deepEqual(calls.at(-1), ["diff", "--numstat", "--no-index", "/dev/null", "new.txt"]);
});
