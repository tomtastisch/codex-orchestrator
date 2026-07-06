#!/usr/bin/env node
import { statSync, mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_BUDGETS, evaluateBudgets, summarize } from "./lib/benchmark.mjs";

const iterations = Number(process.env.ORCH_BENCHMARK_ITERATIONS || "7");
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 50) {
    throw new Error("ORCH_BENCHMARK_ITERATIONS muss eine Ganzzahl zwischen 5 und 50 sein");
}

const serverBundle = resolve("bundle/server.mjs");
const workerBundle = resolve("bundle/worker.mjs");
const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
const coldStartSamples = [];
const doctorSamples = [];
let toolCount = 0;

for (let iteration = 0; iteration < iterations; iteration++) {
    const home = mkdtempSync(join(tmpdir(), "orch-benchmark-"));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverBundle],
        cwd: process.cwd(),
        env: {
            ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
            ORCH_HOME: home,
            ORCH_CODEX_BIN: fakeCodex,
        },
        stderr: "pipe",
    });
    transport.stderr?.resume();
    const client = new Client({ name: "release-benchmark", version: "1" }, { capabilities: {} });
    try {
        const coldStartedAt = performance.now();
        await client.connect(transport);
        const tools = await client.listTools();
        coldStartSamples.push(performance.now() - coldStartedAt);
        toolCount = tools.tools.length;
        if (!tools.tools.some((tool) => tool.name === "orchestrator_doctor")) {
            throw new Error("Benchmark-Bundle enthält orchestrator_doctor nicht");
        }

        const doctorStartedAt = performance.now();
        const response = await client.callTool({ name: "orchestrator_doctor", arguments: {} });
        doctorSamples.push(performance.now() - doctorStartedAt);
        const doctor = JSON.parse(response.content?.[0]?.text || "{}");
        if (response.isError || doctor.ok !== true) throw new Error("Benchmark-Doctor meldet kein gesundes Target");
    } finally {
        await client.close().catch(() => {});
        rmSync(home, { recursive: true, force: true });
    }
}

const coldStart = summarize(coldStartSamples);
const doctor = summarize(doctorSamples);
const metrics = {
    serverBytes: statSync(serverBundle).size,
    workerBytes: statSync(workerBundle).size,
    coldStartP95Ms: coldStart.p95,
    doctorP95Ms: doctor.p95,
};
const budgetResult = evaluateBudgets(metrics, DEFAULT_BUDGETS);
const report = {
    ok: budgetResult.ok,
    environment: { node: process.version, platform: platform(), architecture: arch() },
    iterations,
    toolCount,
    bundles: { serverBytes: metrics.serverBytes, workerBytes: metrics.workerBytes },
    latencyMs: { coldStart, doctor },
    budgets: DEFAULT_BUDGETS,
    violations: budgetResult.violations,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!budgetResult.ok) process.exitCode = 1;
