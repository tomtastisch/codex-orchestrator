export const DEFAULT_BUDGETS = Object.freeze({
    serverBytes: 1_310_720,
    workerBytes: 262_144,
    coldStartP95Ms: 2_500,
    doctorP95Ms: 1_500,
});

function validatedSamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0) throw new Error("Benchmark-Samples dürfen nicht leer sein");
    if (samples.some((sample) => !Number.isFinite(sample))) throw new Error("Benchmark-Samples müssen endlich und finite sein");
    return [...samples].sort((left, right) => left - right);
}

/** Calculate a nearest-rank percentile over finite numeric samples. */
export function percentile(samples, quantile) {
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
        throw new Error(`Ungültiges Quantil: ${quantile}`);
    }
    const sorted = validatedSamples(samples);
    const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
    return sorted[index];
}

/** Return stable summary fields used by CI and release documentation. */
export function summarize(samples) {
    const sorted = validatedSamples(samples);
    return {
        count: sorted.length,
        min: sorted[0],
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1),
    };
}

/** Compare a complete metric set with the release budgets. */
export function evaluateBudgets(metrics, budgets = DEFAULT_BUDGETS) {
    const expected = Object.keys(budgets);
    for (const metric of Object.keys(metrics)) {
        if (!expected.includes(metric)) throw new Error(`Unbekannte Metrik: ${metric}`);
    }
    for (const metric of expected) {
        if (!Number.isFinite(metrics[metric]) || metrics[metric] < 0) {
            throw new Error(`Ungültiger Metrikwert für ${metric}`);
        }
    }
    const violations = expected
        .filter((metric) => metrics[metric] > budgets[metric])
        .map((metric) => ({ metric, actual: metrics[metric], budget: budgets[metric] }));
    return { ok: violations.length === 0, violations };
}
