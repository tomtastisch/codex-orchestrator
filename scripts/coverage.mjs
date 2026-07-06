#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
    coverageArguments,
    discoverTests,
    extractCoverageSummary,
    writeCoverageEvidence,
} from "./lib/coverage.mjs";

const root = process.cwd();
const testFiles = discoverTests(root);
if (testFiles.length === 0) throw new Error("No top-level tests/*.test.mjs files were found");

const result = spawnSync(process.execPath, coverageArguments(testFiles), {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
} else {
    const summary = extractCoverageSummary(result.stdout);
    const evidencePath = writeCoverageEvidence({
        root,
        summary,
        githubSummaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, summary })}\n`);
}
