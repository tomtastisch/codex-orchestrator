#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
    coverageArguments,
    discoverProductionModules,
    discoverTests,
    readCoverageSummary,
    writeCoverageEvidence,
} from "./lib/coverage.mjs";

const root = process.cwd();
const testFiles = discoverTests(root);
if (testFiles.length === 0) throw new Error("No top-level tests/*.test.mjs files were found");
const productionModules = discoverProductionModules(root);
if (productionModules.length === 0) throw new Error("No compiled dist/**/*.js production modules were found");
const require = createRequire(import.meta.url);
const c8Entry = require.resolve("c8/bin/c8.js");

const result = spawnSync(process.execPath, [c8Entry, ...coverageArguments(testFiles)], {
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
    const summary = readCoverageSummary(root, productionModules);
    const evidencePath = writeCoverageEvidence({
        root,
        summary,
        githubSummaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, summary })}\n`);
}
