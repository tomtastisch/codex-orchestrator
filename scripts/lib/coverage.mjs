import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** @typedef {{ lines: number, branches: number, functions: number }} CoverageSummary */

// Source of truth: ssot/limits.json (see ssot/index.toml). Kept in one place so
// the coverage runner, CI gate, README and tests never disagree on the floors.
const limits = JSON.parse(readFileSync(new URL("../../ssot/limits.json", import.meta.url), "utf8"));

export const COVERAGE_FLOORS = Object.freeze({
    lines: limits.coverageLines,
    branches: limits.coverageBranches,
    functions: limits.coverageFunctions,
});

/**
 * Build shell-free c8 arguments for complete production coverage.
 *
 * @param {string[]} testFiles sorted repository-relative test paths
 * @returns {string[]} Node CLI arguments
 */
export function coverageArguments(testFiles) {
    return [
        "--all",
        "--include=dist/**/*.js",
        "--check-coverage",
        `--lines=${COVERAGE_FLOORS.lines}`,
        `--branches=${COVERAGE_FLOORS.branches}`,
        `--functions=${COVERAGE_FLOORS.functions}`,
        "--reporter=text",
        "--reporter=json-summary",
        "--reports-dir=coverage",
        "node",
        "--test",
        ...testFiles,
    ];
}

/**
 * Discover the repository's Node test modules recursively and deterministically.
 *
 * The walk descends into subdirectories so nested suites (e.g. tests/unit/*.test.mjs)
 * are included in the coverage denominator as the layout grows.
 *
 * @param {string} root absolute repository root
 * @returns {string[]} sorted repository-relative POSIX test paths
 */
export function discoverTests(root) {
    const tests = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
                tests.push(relative(root, path).split(sep).join("/"));
            }
        }
    };
    visit(join(root, "tests"));
    return tests.sort();
}

/**
 * Inventory every compiled production JavaScript module deterministically.
 *
 * @param {string} root absolute repository root
 * @returns {string[]} sorted repository-relative POSIX paths
 */
export function discoverProductionModules(root) {
    const modules = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".js")) {
                modules.push(relative(root, path).split(sep).join("/"));
            }
        }
    };
    visit(join(root, "dist"));
    return modules.sort();
}

/**
 * Read c8 JSON evidence and reject incomplete or malformed production coverage.
 *
 * @param {string} root absolute repository root
 * @param {string[]} productionModules repository-relative production module paths
 * @returns {CoverageSummary} numeric aggregate coverage
 */
export function readCoverageSummary(root, productionModules) {
    const path = join(root, "coverage", "coverage-summary.json");
    let report;
    try {
        report = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`Invalid coverage summary: ${error instanceof Error ? error.message : String(error)}`);
    }

    // c8 records absolute file paths as report keys, but the separator style is
    // platform-dependent (POSIX '/' vs Windows '\\') and can differ from what
    // path.resolve produces on the same host. Normalise both sides to POSIX
    // separators so the inventory check never reports a false "missing" module.
    const toPosix = (path) => path.split(sep).join("/").split("\\").join("/");
    const reportKeys = new Set(Object.keys(report).map(toPosix));
    const missing = productionModules.filter((module) => !reportKeys.has(toPosix(resolve(root, module))));
    if (missing.length > 0) {
        throw new Error(`Coverage summary is missing production modules: ${missing.join(", ")}`);
    }

    const percentage = (metric) => {
        const value = report?.total?.[metric]?.pct;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
            throw new Error(`Invalid coverage summary metric: ${metric}`);
        }
        return value;
    };
    return {
        lines: percentage("lines"),
        branches: percentage("branches"),
        functions: percentage("functions"),
    };
}

/**
 * Render the coverage evidence for GitHub Job Summary and local artifacts.
 *
 * @param {CoverageSummary} summary numeric aggregate coverage
 * @returns {string} Markdown summary ending with one newline
 */
export function formatCoverageMarkdown(summary) {
    return [
        "## Production coverage",
        "",
        "| Metric | Actual | Required |",
        "|---|---:|---:|",
        `| Lines | ${summary.lines.toFixed(2)} % | ${COVERAGE_FLOORS.lines} % |`,
        `| Branches | ${summary.branches.toFixed(2)} % | ${COVERAGE_FLOORS.branches} % |`,
        `| Functions | ${summary.functions.toFixed(2)} % | ${COVERAGE_FLOORS.functions} % |`,
        "",
    ].join("\n");
}

/**
 * Persist local coverage evidence and optionally append it to GitHub Job Summary.
 *
 * @param {{ root: string, summary: CoverageSummary, githubSummaryPath?: string }} options output options
 * @returns {string} absolute path of the durable local summary
 */
export function writeCoverageEvidence(options) {
    const directory = join(options.root, "coverage");
    const destination = join(directory, "summary.txt");
    const temporary = `${destination}.tmp`;
    const markdown = formatCoverageMarkdown(options.summary);
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, markdown, "utf8");
    renameSync(temporary, destination);
    if (options.githubSummaryPath) appendFileSync(options.githubSummaryPath, markdown, "utf8");
    return destination;
}
