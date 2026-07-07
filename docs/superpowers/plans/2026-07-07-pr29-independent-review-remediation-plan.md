# PR #29 Independent Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every independently documented PR #29 finding, make the quality gates measure the complete production surface, and merge only after repeated independent review approves the exact final head with zero unresolved threads.

**Architecture:** Keep process execution shell-free while delegating Windows executable-shim resolution to `cross-spawn`. Replace Node's loaded-module-only coverage mode with `c8 --all`, exercise the compiled MCP server and previously untested production modules, prove the declared Node lower bounds in CI, and pin every external action to an immutable commit. Encode the Copilot-unavailable fallback as repository policy; create a separate governance issue for API-driven availability evidence because GitHub exposes no reliable Copilot quota endpoint.

**Tech Stack:** TypeScript 5.9, Node.js 22.5/22-current/24.0/24-current, Node test runner, c8 11, cross-spawn 7, GitHub Actions, GitHub GraphQL review threads.

---

## File map

- `src/runtime/process.ts`: central shell-free managed process launcher.
- `tests/security-boundaries.test.mjs`: Windows launcher and command-injection regressions.
- `package.json`, `package-lock.json`: direct runtime/dev dependency ownership.
- `scripts/coverage.mjs`, `scripts/lib/coverage.mjs`: complete production coverage execution and evidence parsing.
- `tests/coverage-runner.test.mjs`: coverage CLI, inventory and fail-closed evidence contracts.
- `tests/project-boundary.test.mjs`, `tests/prompts.test.mjs`: MCP integration against compiled `dist/server.js` so server behavior contributes to coverage.
- `tests/agents.test.mjs`, `tests/checks.test.mjs`, `tests/resolve.test.mjs`, `tests/updater.test.mjs`, `tests/worktree.test.mjs`, `tests/execution-registry.test.mjs`: direct behavior tests for currently unloaded production modules.
- `.github/workflows/ci.yml`: exact Node boundary jobs and immutable action pins.
- `.github/workflows/codeql.yml`, `.github/workflows/release.yml`: immutable external action pins.
- `tests/quality-policy.test.mjs`, `tests/release-policy.test.mjs`: CI boundary and supply-chain contracts.
- `AGENTS.md`, `CLAUDE.md`: mandatory independent-review fallback and merge gate.
- `tests/review-policy.test.mjs`: repository-policy contract for the fallback workflow.

### Task 1: Persist the reviewed remediation contract

**Files:**
- Create: `docs/superpowers/plans/2026-07-07-pr29-independent-review-remediation-plan.md`

- [ ] **Step 1: Verify the independent review belongs to the exact PR head**

Run the GitHub GraphQL thread query for PR #29 and require head `2a4c50ddb2eb70c0f7256982e7bdc232fa670f2b`, four agent-authored threads, `isResolved=false`, and `isOutdated=false`.

- [ ] **Step 2: Commit the plan**

```bash
git add docs/superpowers/plans/2026-07-07-pr29-independent-review-remediation-plan.md
git commit -m "docs: plan independent review remediation"
```

### Task 2: Make Windows executable shims launch shell-free

**Files:**
- Modify: `src/runtime/process.ts`
- Modify: `tests/security-boundaries.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing Windows regression contract**

Replace the assertion that preserves a bare `codex` command with a regression that verifies managed execution uses a cross-platform spawn implementation and never enables `shell`. Keep the existing `.js` launcher mapping assertion. Add a Windows-only integration test that creates a temporary `codex.cmd`, prepends its directory to `PATH`, invokes `startManagedProcess({ command: "codex" })`, and expects exit code `0` plus the shim output.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm run build && node --test --test-name-pattern="Windows|shell" tests/security-boundaries.test.mjs
```

Expected: the source contract or Windows integration test fails because `node:child_process.spawn` does not resolve `.cmd` shims with `shell:false`.

- [ ] **Step 3: Add owned dependencies and the minimal implementation**

Run:

```bash
npm install cross-spawn@7.0.6
npm install --save-dev @types/cross-spawn@6.0.6
```

Import `spawn` and `ChildProcess` types from `cross-spawn`, preserve `resolveManagedCommand` for direct JavaScript launchers, and call cross-spawn with the existing argv, environment, cwd and piped stdio. Do not add `shell:true` and do not concatenate argv into a command string.

- [ ] **Step 4: Run focused and full process tests**

```bash
npm run typecheck
npm run build && node --test --test-name-pattern="managed process|Windows" tests/security-boundaries.test.mjs
npm test
```

Expected: all pass; the Windows CI job supplies the real `.cmd` proof.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/process.ts tests/security-boundaries.test.mjs package.json package-lock.json
git commit -m "fix: launch Windows command shims safely"
```

### Task 3: Count every compiled production module in coverage

**Files:**
- Modify: `scripts/coverage.mjs`
- Modify: `scripts/lib/coverage.mjs`
- Modify: `tests/coverage-runner.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write a failing complete-inventory coverage contract**

Change the expected arguments to require:

```js
[
    "--all",
    "--include=dist/**/*.js",
    "--check-coverage",
    "--lines=75",
    "--branches=70",
    "--functions=75",
    "--reporter=text",
    "--reporter=json-summary",
    "--reports-dir=coverage",
    "node",
    "--test",
    "tests/a.test.mjs",
]
```

Add a test that inventories every `dist/**/*.js` file and fails when a synthetic c8 JSON summary omits any inventory member. Add malformed/missing-summary tests that require a fail-closed error.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test tests/coverage-runner.test.mjs
```

Expected: failure because the existing runner uses Node's loaded-module-only coverage and has no full inventory validation.

- [ ] **Step 3: Implement c8 all-file coverage**

Run `npm install --save-dev c8@11.0.0`. Resolve the local c8 entry point without `npx`, run it through `process.execPath`, read `coverage/coverage-summary.json`, verify that every compiled JavaScript file has a summary entry, and then write the existing Markdown evidence. Retain floors of 75% lines, 70% branches and 75% functions.

- [ ] **Step 4: Verify the focused runner and observe the expected global RED**

```bash
node --test tests/coverage-runner.test.mjs
npm run test:coverage
```

Expected: runner unit tests pass; the global coverage command fails until the complete production surface reaches the unchanged floors.

### Task 4: Close real complete-surface coverage gaps

**Files:**
- Modify: `tests/project-boundary.test.mjs`
- Modify: `tests/prompts.test.mjs`
- Create: `tests/agents.test.mjs`
- Create: `tests/checks.test.mjs`
- Create: `tests/resolve.test.mjs`
- Create: `tests/updater.test.mjs`
- Create: `tests/worktree.test.mjs`
- Create: `tests/execution-registry.test.mjs`
- Test: all `tests/*.test.mjs`

- [ ] **Step 1: Exercise the compiled server instead of only the bundle**

Change the two MCP transports from `bundle/server.mjs` to `dist/server.js`. Keep bundle verification in its dedicated gate. Run the two tests and require successful prompt listing, repository validation, plan creation, doctor response and persisted-repository failure behavior.

- [ ] **Step 2: Add direct behavior tests for unloaded modules**

Implement deterministic tests for:

- `ensureAgentsMd`: created, present and appended actions in temporary directories;
- `runChecks`/`diffSize`: known, unknown, passing, failing, secret-redacted and untracked-file paths with a fake `ExecutionTarget`;
- `resolveModel`, `repoPathForCluster`, `latestWorktreeForCluster`: explicit/auto models plus missing/valid cluster and task data;
- updater semver and version discovery: older/equal/prerelease cases and fixture executables for success/failure, while disabling actual update installation;
- `WorktreeManager`: non-repository rejection plus create/list/merge/remove in temporary Git repositories;
- `ExecutionTargetRegistry`: register/get/list, unknown-target failure, local-only runtime, and validated remote runtime registration.

- [ ] **Step 3: Run targeted tests, then the full all-file gate**

```bash
npm run build
node --test tests/agents.test.mjs tests/checks.test.mjs tests/resolve.test.mjs tests/updater.test.mjs tests/worktree.test.mjs tests/execution-registry.test.mjs tests/project-boundary.test.mjs tests/prompts.test.mjs
npm run test:coverage
```

Expected: every target test passes and complete all-file coverage meets at least 75% lines, 70% branches and 75% functions. If a floor remains below its fixed value, use the emitted per-file uncovered lines to add a behavior assertion for that exact reachable path; do not exclude a production module and do not lower a floor.

- [ ] **Step 4: Commit Tasks 3 and 4 together after the global gate is green**

```bash
git add scripts/coverage.mjs scripts/lib/coverage.mjs tests/coverage-runner.test.mjs tests/project-boundary.test.mjs tests/prompts.test.mjs tests/agents.test.mjs tests/checks.test.mjs tests/resolve.test.mjs tests/updater.test.mjs tests/worktree.test.mjs tests/execution-registry.test.mjs package.json package-lock.json
git commit -m "test: measure the complete production surface"
```

### Task 5: Prove the declared Node lower bounds

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/quality-policy.test.mjs`

- [ ] **Step 1: Write the failing CI matrix contract**

Require exact matrix entries `"22.5.0"`, `"22"`, `"24.0.0"`, and `"24"` for each of `ubuntu-latest`, `macos-15`, and `windows-latest`. Reject a matrix containing only the moving major aliases.

- [ ] **Step 2: Run the contract and verify RED**

```bash
node --test tests/quality-policy.test.mjs
```

Expected: failure because `22.5.0` and `24.0.0` are absent.

- [ ] **Step 3: Extend the portable matrix**

Set `matrix.node` to `["22.5.0", "22", "24.0.0", "24"]` while retaining all three operating systems and `fail-fast: false`. Do not weaken package engines or README claims.

- [ ] **Step 4: Run the contract and commit**

```bash
node --test tests/quality-policy.test.mjs
git add .github/workflows/ci.yml tests/quality-policy.test.mjs
git commit -m "ci: verify declared Node boundaries"
```

### Task 6: Pin external GitHub Actions immutably

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/codeql.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/quality-policy.test.mjs`
- Modify: `tests/release-policy.test.mjs`

- [ ] **Step 1: Write the failing immutable-reference contract**

Require every external `uses:` value to match `owner/repository@<40 lowercase hex>` followed by an inline release comment. Reject mutable `@vN` references. Keep local reusable workflow references exempt.

- [ ] **Step 2: Run the contract and verify RED**

```bash
node --test tests/quality-policy.test.mjs tests/release-policy.test.mjs
```

Expected: failure on every current major-tag reference.

- [ ] **Step 3: Apply verified release commits**

Use these GitHub-API-verified commits consistently:

```text
actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
github/codeql-action/init@54f647b7e1bb85c95cddabcd46b0c578ec92bc1a # v4.36.3
github/codeql-action/analyze@54f647b7e1bb85c95cddabcd46b0c578ec92bc1a # v4.36.3
```

- [ ] **Step 4: Run policy tests and commit**

```bash
node --test tests/quality-policy.test.mjs tests/release-policy.test.mjs
git add .github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/release.yml tests/quality-policy.test.mjs tests/release-policy.test.mjs
git commit -m "ci: pin external actions immutably"
```

### Task 7: Encode the independent-review fallback

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `tests/review-policy.test.mjs`

- [ ] **Step 1: Write the failing policy contract**

Require both policy files to state: exact-head review, green CI before review, all findings as unresolved PR threads, iterative fix/reply/resolve, zero unresolved threads, a clean-context read-only independent agent when Copilot is unavailable, and repetition until explicit merge approval. Require explicit wording that an absent review is `unavailable/unknown`, not proof of quota exhaustion.

- [ ] **Step 2: Run the policy test and verify RED**

```bash
node --test tests/review-policy.test.mjs
```

Expected: failure because the fallback is not yet encoded.

- [ ] **Step 3: Add the mandatory workflow**

Document in `AGENTS.md` the executor-side requirements and in `CLAUDE.md` the orchestrator merge-gate order. State that only explicit provider/operator evidence may classify quota exhaustion; API silence remains fail-closed `unavailable/unknown`. Require the independent agent to author PR threads, the primary agent to address them, and a fresh exact-head review after every correction round.

- [ ] **Step 4: Verify and commit**

```bash
node --test tests/review-policy.test.mjs
git add AGENTS.md CLAUDE.md tests/review-policy.test.mjs
git commit -m "docs: require independent review fallback"
```

- [ ] **Step 5: Create a separate automation issue**

Create one child issue under Epic #16 defining an exact-head Copilot review check, bounded request timeout, `unavailable/unknown` fail-closed state, explicit-evidence-only `quota_exhausted` state, independent-review artifact, unresolved-thread count and merge gate. Link it as blocked by #23 so automation starts only after the baseline is merged. Read the issue back and verify both native relationships.

### Task 8: Verify, resolve, repeat independent review, and merge

**Files:**
- No planned code changes; any new review finding starts a new TDD correction commit.

- [ ] **Step 1: Run every local release gate**

```bash
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
git diff --check
```

- [ ] **Step 2: Push and require green GitHub checks**

Push the branch, then require every current-head CI and CodeQL check to succeed. Do not resolve threads on local evidence alone.

- [ ] **Step 3: Reply to and resolve the four documented findings**

For each thread, reply in-thread with the fixing commit, targeted test, full gate and CI evidence. Resolve only after readback confirms the response and the thread still targets the corrected change. Query GraphQL and require unresolved count `0`.

- [ ] **Step 4: Request an independent exact-head review**

Reuse the independent reviewer without implementation context. Require it to inspect the complete PR diff and current tests. If it finds anything, it must create separate unresolved inline PR threads. The primary agent then verifies and handles each finding test-first, pushes, waits for green CI, replies and resolves, and requests another clean exact-head review.

- [ ] **Step 5: Repeat until explicit approval**

Continue Step 4 without a fixed round limit until the independent reviewer explicitly reports no findings and approves merging. Before merge, require: reviewer head equals PR head, every required check green, unresolved review-thread count `0`, and no uncommitted changes.

- [ ] **Step 6: Merge and verify main**

Merge PR #29, verify the merge commit on `main`, require main CI/CodeQL green, confirm Issue #23 closed, confirm the separate fallback-automation issue remains open with correct links, and remove only the merged branch/worktree owned by this task.

- [ ] **Step 7: Stop this task**

Report the merge commit and verification evidence, then end the task so the remaining issue sequence can continue in a new chat.
