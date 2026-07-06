import { test } from "node:test";
import assert from "node:assert/strict";

test("benchmark percentile and summary are deterministic", async () => {
    const { percentile, summarize } = await import("../scripts/lib/benchmark.mjs");
    const samples = [50, 10, 40, 20, 30];
    assert.equal(percentile(samples, 0.95), 50);
    assert.deepEqual(summarize(samples), { count: 5, min: 10, median: 30, p95: 50, max: 50 });
    assert.throws(() => percentile([], 0.95), /sample|leer/i);
    assert.throws(() => percentile([1, Number.NaN], 0.95), /finite|endlich/i);
});

test("benchmark budgets report every violation", async () => {
    const { DEFAULT_BUDGETS, evaluateBudgets } = await import("../scripts/lib/benchmark.mjs");
    const metrics = {
        serverBytes: DEFAULT_BUDGETS.serverBytes + 1,
        workerBytes: DEFAULT_BUDGETS.workerBytes,
        coldStartP95Ms: DEFAULT_BUDGETS.coldStartP95Ms + 1,
        doctorP95Ms: DEFAULT_BUDGETS.doctorP95Ms,
    };
    const result = evaluateBudgets(metrics, DEFAULT_BUDGETS);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations.map((entry) => entry.metric), ["serverBytes", "coldStartP95Ms"]);
    assert.throws(
        () => evaluateBudgets({ ...metrics, unknownMetric: 1 }, DEFAULT_BUDGETS),
        /unknownMetric|Unbekannte Metrik/,
    );
});

test("benchmark budgets accept values at their exact limits", async () => {
    const { DEFAULT_BUDGETS, evaluateBudgets } = await import("../scripts/lib/benchmark.mjs");
    assert.deepEqual(evaluateBudgets({ ...DEFAULT_BUDGETS }, DEFAULT_BUDGETS), { ok: true, violations: [] });
});
