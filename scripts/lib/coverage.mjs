import { appendFileSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ lines: number, branches: number, functions: number }} CoverageSummary */

export const COVERAGE_FLOORS = Object.freeze({ lines: 75, branches: 70, functions: 75 });

/**
 * Build shell-free Node test-runner arguments for production coverage.
 *
 * @param {string[]} testFiles sorted repository-relative test paths
 * @returns {string[]} Node CLI arguments
 */
export function coverageArguments(testFiles) {
    return [
        "--experimental-test-coverage",
        "--test-coverage-include=dist/**/*.js",
        `--test-coverage-lines=${COVERAGE_FLOORS.lines}`,
        `--test-coverage-branches=${COVERAGE_FLOORS.branches}`,
        `--test-coverage-functions=${COVERAGE_FLOORS.functions}`,
        "--test",
        ...testFiles,
    ];
}

/**
 * Discover the repository's top-level Node test modules deterministically.
 *
 * @param {string} root absolute repository root
 * @returns {string[]} sorted repository-relative test paths
 */
export function discoverTests(root) {
    return readdirSync(join(root, "tests"))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => `tests/${name}`);
}

/**
 * Parse Node's aggregate coverage row.
 *
 * @param {string} output complete Node test-runner stdout
 * @returns {CoverageSummary} numeric aggregate coverage
 */
export function extractCoverageSummary(output) {
    const match = output.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (!match) throw new Error("Node test output is missing the aggregate coverage row");
    return {
        lines: Number(match[1]),
        branches: Number(match[2]),
        functions: Number(match[3]),
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
