# Issue #23 Quality Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish mandatory Node.js 22/24, Ubuntu/macOS/Windows, production-coverage, CodeQL and PR-artifact gates before architecture work begins.

**Architecture:** Keep the existing Node test runner and release pipeline. Add one cross-platform CI matrix, one canonical Ubuntu quality job, a dependency-free coverage runner with a testable parser, and a separate least-privilege CodeQL workflow. Contract tests treat workflow and runtime-support metadata as product behavior.

**Tech Stack:** Node.js 22/24, TypeScript 5.9, `node:test`, GitHub Actions, CodeQL Action v4, Upload Artifact v7, Anthropic MCPB CLI.

---

## File map

- Modify `package.json`: exact supported Node LTS ranges and the coverage command.
- Modify `package-lock.json`: synchronize root engine metadata.
- Create `.nvmrc`: select Node.js 24 as the local development default.
- Create `scripts/lib/coverage.mjs`: test-file discovery, coverage arguments, parsing and summary formatting.
- Create `scripts/coverage.mjs`: run native Node coverage, write `coverage/summary.txt`, and append the GitHub Job Summary.
- Modify `.gitignore`: ignore generated local coverage output.
- Modify `.github/workflows/ci.yml`: portable matrix, canonical quality gate and PR artifacts.
- Create `.github/workflows/codeql.yml`: JavaScript/TypeScript and Actions analysis.
- Create `tests/quality-policy.test.mjs`: runtime, CI, CodeQL and artifact contracts.
- Create `tests/coverage-runner.test.mjs`: behavior tests for the coverage runner library.
- Modify `tests/release-policy.test.mjs`: align the reusable release gate with the new CI job names and current action majors.
- Modify `tests/readme-contract.test.mjs`: require exact runtime and verified-platform documentation.
- Modify `README.md`: document Node LTS support, platform evidence, coverage and CodeQL gates.

### Task 1: Lock the quality policy with failing contract tests

**Files:**
- Create: `tests/quality-policy.test.mjs`
- Modify: `tests/release-policy.test.mjs`
- Modify: `tests/readme-contract.test.mjs`

- [ ] **Step 1: Create the failing quality-policy contract**

Create `tests/quality-policy.test.mjs` with tests that read real repository files and require:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

test("package supports only the verified Node LTS lines", () => {
    assert.equal(pkg.engines.node, ">=22.5.0 <23 || >=24 <25");
    assert.equal(readFileSync(".nvmrc", "utf8"), "24\n");
});

test("CI requires the complete Node and operating-system matrix", () => {
    for (const value of ["ubuntu-latest", "macos-15", "windows-latest", '"22"', '"24"']) {
        assert.ok(ci.includes(value), `CI matrix entry missing: ${value}`);
    }
    assert.match(ci, /portable:[\s\S]*fail-fast: false/);
    assert.match(ci, /portable:[\s\S]*npm run typecheck[\s\S]*npm test[\s\S]*npm run bundle[\s\S]*npm run verify:bundle/);
    assert.doesNotMatch(ci, /continue-on-error:\s*true/);
});

test("canonical quality gate enforces coverage and release-candidate checks", () => {
    for (const command of [
        "npm run test:coverage", "npm run mcpb:validate", "npm run mcpb:build",
        "npm run mcpb:verify", "npm run benchmark", "node scripts/bundlecheck.mjs",
        "plugin validate . --strict", "npm audit --audit-level=moderate",
    ]) assert.ok(ci.includes(command), `quality command missing: ${command}`);
    assert.match(ci, /actions\/upload-artifact@v7/);
    assert.match(ci, /retention-days: 7/);
    assert.match(ci, /coverage\/summary\.txt/);
    assert.match(ci, /release\/\*\.mcpb/);
    assert.match(ci, /release\/\*\.sha256/);
});

test("CodeQL scans application and workflow code with current actions", () => {
    assert.equal(existsSync(".github/workflows/codeql.yml"), true);
    const codeql = readFileSync(".github/workflows/codeql.yml", "utf8");
    assert.match(codeql, /javascript-typescript/);
    assert.match(codeql, /language: actions/);
    assert.match(codeql, /queries: security-and-quality/);
    assert.match(codeql, /github\/codeql-action\/init@v4/);
    assert.match(codeql, /github\/codeql-action\/analyze@v4/);
    assert.match(codeql, /security-events: write/);
    assert.match(codeql, /schedule:/);
    assert.doesNotMatch(codeql, /continue-on-error:\s*true/);
});
```

- [ ] **Step 2: Extend existing release and README contracts**

Update `tests/release-policy.test.mjs` so the release job requires:

```js
assert.match(ci, /release:[\s\S]*needs: \[portable, quality, remote-acceptance\]/);
assert.match(ci, /actions\/upload-artifact@v7/);
```

Update `tests/readme-contract.test.mjs` with:

```js
test("README documents the verified runtime and quality matrix", () => {
    assert.match(readme, /Node\.js 22\.5–22\.x and Node\.js 24\.x/);
    for (const platform of ["Ubuntu", "macOS", "Windows"]) assert.ok(readme.includes(platform));
    assert.match(readme, /75 % lines, 70 % branches and 75 % functions/);
    assert.match(readme, /CodeQL/);
});
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npm run build
node --test --test-name-pattern="quality|Node LTS|runtime and quality matrix|current supported action majors" tests/*.test.mjs
```

Expected: failures for the old engine range, missing `.nvmrc`, missing matrix, missing CodeQL, missing upload action and missing README text.

- [ ] **Step 4: Commit the verified failing contracts**

```bash
git add tests/quality-policy.test.mjs tests/release-policy.test.mjs tests/readme-contract.test.mjs
git commit -m "test: define cross-platform quality policy"
```

### Task 2: Implement runtime metadata and the portable matrix

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.nvmrc`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Restrict supported Node.js lines**

Set both root engine entries in `package.json` and `package-lock.json` to:

```json
"node": ">=22.5.0 <23 || >=24 <25"
```

Create `.nvmrc` with exactly:

```text
24
```

- [ ] **Step 2: Replace the single test job with the portable matrix**

Use this job in `.github/workflows/ci.yml`:

```yaml
  portable:
    name: portable (${{ matrix.os }}, node-${{ matrix.node }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-15, windows-latest]
        node: ["22", "24"]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run bundle
      - run: npm run verify:bundle
```

Preserve `remote-acceptance` on `macos-15` and Node.js 22. Add a temporary `quality` job on Ubuntu Node.js 22 containing the existing non-portable checks. Change the reusable release job to:

```yaml
    needs: [portable, quality, remote-acceptance]
```

- [ ] **Step 3: Verify the runtime and matrix contracts turn GREEN**

Run:

```bash
npm run build
node --test tests/quality-policy.test.mjs tests/release-policy.test.mjs
```

Expected: runtime and matrix assertions pass; CodeQL, coverage artifact and README assertions remain red.

- [ ] **Step 4: Commit runtime and matrix changes**

```bash
git add package.json package-lock.json .nvmrc .github/workflows/ci.yml
git commit -m "ci: test supported Node LTS lines across platforms"
```

### Task 3: Add the native production-coverage gate

**Files:**
- Create: `tests/coverage-runner.test.mjs`
- Create: `scripts/lib/coverage.mjs`
- Create: `scripts/coverage.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing coverage-library tests**

Create `tests/coverage-runner.test.mjs` to require:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    coverageArguments,
    extractCoverageSummary,
    formatCoverageMarkdown,
} from "../scripts/lib/coverage.mjs";

test("coverage arguments scope metrics to production output and enforce floors", () => {
    assert.deepEqual(coverageArguments(["tests/a.test.mjs"]), [
        "--experimental-test-coverage",
        "--test-coverage-include=dist/**/*.js",
        "--test-coverage-lines=75",
        "--test-coverage-branches=70",
        "--test-coverage-functions=75",
        "--test",
        "tests/a.test.mjs",
    ]);
});

test("coverage summary parser accepts Node's aggregate row", () => {
    const summary = extractCoverageSummary("ℹ all files | 77.39 | 75.52 | 77.74 |\n");
    assert.deepEqual(summary, { lines: 77.39, branches: 75.52, functions: 77.74 });
    assert.match(formatCoverageMarkdown(summary), /77\.39 %/);
});

test("coverage summary parser fails closed on missing output", () => {
    assert.throws(() => extractCoverageSummary("no coverage"), /aggregate coverage row/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/coverage-runner.test.mjs
```

Expected: module-not-found for `scripts/lib/coverage.mjs`.

- [ ] **Step 3: Implement the minimal coverage library**

Create `scripts/lib/coverage.mjs` with:

```js
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const COVERAGE_FLOORS = Object.freeze({ lines: 75, branches: 70, functions: 75 });

/** @param {string[]} testFiles @returns {string[]} */
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

/** @param {string} root @returns {string[]} */
export function discoverTests(root) {
    return readdirSync(join(root, "tests"))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => `tests/${name}`);
}

/** @param {string} output @returns {{lines:number, branches:number, functions:number}} */
export function extractCoverageSummary(output) {
    const match = output.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (!match) throw new Error("Node test output is missing the aggregate coverage row");
    return { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
}

/** @param {{lines:number, branches:number, functions:number}} summary @returns {string} */
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
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test tests/coverage-runner.test.mjs
```

Expected: 3 tests pass.

- [ ] **Step 5: Implement the cross-platform coverage CLI**

Create `scripts/coverage.mjs` that:

1. discovers sorted `tests/*.test.mjs` files;
2. invokes `process.execPath` with `coverageArguments()` and `shell: false`;
3. streams captured stdout/stderr back to the terminal;
4. exits with the child status if thresholds or tests fail;
5. parses the aggregate row;
6. writes `coverage/summary.txt` atomically;
7. appends the Markdown table to `GITHUB_STEP_SUMMARY` when that variable is set.

Use `spawnSync`, `mkdirSync`, `writeFileSync`, `renameSync` and `appendFileSync`.
Write first to `coverage/summary.txt.tmp` and rename it to
`coverage/summary.txt`; do not invoke a shell and do not add a coverage
dependency.

Change the package script to:

```json
"test:coverage": "npm run build && node scripts/coverage.mjs"
```

Add to `.gitignore`:

```text
coverage/
```

- [ ] **Step 6: Verify the real coverage gate**

Run:

```bash
npm run test:coverage
test -s coverage/summary.txt
```

Expected: 153 or more tests pass and the aggregate production coverage remains at or above 75/70/75.

- [ ] **Step 7: Commit the coverage gate**

```bash
git add tests/coverage-runner.test.mjs scripts/lib/coverage.mjs scripts/coverage.mjs package.json .gitignore
git commit -m "test: enforce production coverage floors"
```

### Task 4: Add CodeQL with least privilege

**Files:**
- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Create the CodeQL workflow**

Use:

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 3 * * 1"

permissions:
  contents: read

jobs:
  analyze:
    name: analyze (${{ matrix.language }})
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      packages: read
      contents: read
    strategy:
      fail-fast: false
      matrix:
        include:
          - language: javascript-typescript
            build-mode: none
          - language: actions
            build-mode: none
    steps:
      - uses: actions/checkout@v7
      - uses: github/codeql-action/init@v4
        with:
          languages: ${{ matrix.language }}
          build-mode: ${{ matrix.build-mode }}
          queries: security-and-quality
      - uses: github/codeql-action/analyze@v4
        with:
          category: "/language:${{ matrix.language }}"
```

- [ ] **Step 2: Verify the CodeQL contract turns GREEN**

Run:

```bash
node --test tests/quality-policy.test.mjs
```

Expected: CodeQL contract passes; artifact and README assertions remain red.

- [ ] **Step 3: Commit CodeQL**

```bash
git add .github/workflows/codeql.yml
git commit -m "ci: add CodeQL security and quality analysis"
```

### Task 5: Publish bounded PR artifacts and document the evidence

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] **Step 1: Add canonical quality artifacts**

After `mcpb:verify` in the `quality` job, determine the version and upload with:

```yaml
      - name: Read package version
        id: package
        shell: bash
        run: echo "version=$(node -p \"require('./package.json').version\")" >> "$GITHUB_OUTPUT"
      - name: Upload verified PR artifacts
        uses: actions/upload-artifact@v7
        with:
          name: quality-${{ github.sha }}-v${{ steps.package.outputs.version }}
          path: |
            release/*.mcpb
            release/*.sha256
            coverage/summary.txt
          if-no-files-found: error
          retention-days: 7
```

Keep Release publishing in `.github/workflows/release.yml`; the quality artifact is evidence, not a GitHub Release.

- [ ] **Step 2: Document exact support and gates**

Update the README badge and prerequisites to state:

```text
Node.js 22.5–22.x and Node.js 24.x are supported for external runtimes.
Ubuntu, macOS and Windows are tested in CI on both LTS lines.
```

In the development/testing section document:

```text
npm run test:coverage  # dist production code; floors: 75 % lines, 70 % branches, 75 % functions
```

Explain that CodeQL analyzes JavaScript/TypeScript and GitHub Actions and that PR quality artifacts are retained for seven days separately from the single stable GitHub Release.

- [ ] **Step 3: Verify all policy contracts turn GREEN**

Run:

```bash
npm run build
node --test tests/quality-policy.test.mjs tests/release-policy.test.mjs tests/readme-contract.test.mjs
```

Expected: all tests pass.

- [ ] **Step 4: Commit artifact and documentation changes**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "docs: publish and explain quality evidence"
```

### Task 6: Run the complete release-equivalent verification

**Files:**
- Modify only files required by failures proven during this task.

- [ ] **Step 1: Run formatting and repository checks**

```bash
git diff --check
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run bundle
npm run verify:bundle
npm run mcpb:validate
npm run mcpb:build
npm run mcpb:verify
npm run benchmark
node scripts/bundlecheck.mjs
npx --yes @anthropic-ai/claude-code plugin validate . --strict
npm audit --audit-level=moderate
```

Expected: every command exits 0, coverage remains at or above 75/70/75, audit reports zero moderate-or-higher vulnerabilities.

- [ ] **Step 2: Verify no policy drift**

```bash
node --test tests/quality-policy.test.mjs tests/release-policy.test.mjs tests/readme-contract.test.mjs tests/coverage-runner.test.mjs
git status --short
```

Expected: all contract tests pass; only intentional source changes are present and generated `coverage/`, `dist/` and `release/` remain ignored.

- [ ] **Step 3: Commit any verification-only correction**

If Step 1 exposed a real defect, add only the corresponding test and minimal fix, then commit with a specific message. If no correction is needed, do not create an empty commit.

### Task 7: Publish, review, merge and close #23

**Files:**
- No new implementation files unless review finds a verified defect.

- [ ] **Step 1: Push and open the PR**

Push `codex/issue-23-quality-gates` and create a PR whose body includes:

```text
Closes #23
```

List every local verification command and the measured coverage values.

- [ ] **Step 2: Wait for every CI and CodeQL job**

Require all six portable matrix jobs, quality, remote acceptance and both CodeQL analyses to pass. Release must be skipped on the PR.

- [ ] **Step 3: Request Copilot on the exact green head**

Request `@copilot` only after CI and CodeQL are green. Read back the review commit SHA and require it to equal the current PR head SHA.

- [ ] **Step 4: Process every review thread**

For each thread:

1. verify the finding against the repository;
2. fix only valid findings with a failing test first;
3. push and repeat all required checks;
4. request Copilot re-review for the new head;
5. reply in the original thread and resolve it only after verification.

- [ ] **Step 5: Merge and verify main**

Merge only when all required checks pass, Copilot reviewed the final head and unresolved thread count is zero. Then verify the merge-commit CI, close #23 through the PR, delete the branch/worktree, and re-read #19 plus #24 before starting either one.
