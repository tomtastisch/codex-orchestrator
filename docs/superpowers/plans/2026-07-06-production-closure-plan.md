# Production Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining runtime redundancies, prove persistent remote authentication over real OpenSSH restarts, and enforce measurable release efficiency budgets.

**Architecture:** Keep one canonical redaction engine and one marketplace-owned update path. Propagate `codexHome` explicitly through target, protocol and worker boundaries. Add a self-cleaning OpenSSH acceptance harness plus an MCP cold-start benchmark that both fail closed.

**Tech Stack:** TypeScript 5, Node.js 22, Node test runner, MCP SDK, Zod, OpenSSH (`ssh`, `scp`, `sshd`), esbuild, GitHub Actions.

---

## File structure

- Delete `src/plugin.ts`: obsolete plugin self-update implementation.
- Delete `tests/plugin.test.mjs`: tests only deleted runtime-dead behavior.
- Modify `src/runtime/redaction.ts`: compatibility adapter to canonical `src/redact.ts`.
- Create `tests/redundancy.test.mjs`: structural anti-regression checks.
- Modify `src/codex.ts`: explicit optional `codexHome` for Codex child environment.
- Modify `src/execution/local-target.ts`: target-owned `codexHome` for doctor and slices.
- Modify `src/execution/ssh/protocol.ts`: require `codexHome` for doctor and Codex operations.
- Modify `src/execution/ssh/target.ts`: transmit configured remote `codexHome`.
- Modify `src/execution/registry.ts`: pass validated remote `codexHome` to the SSH target.
- Modify `src/worker/operations.ts`: create local worker targets with requested `codexHome`.
- Modify `tests/local-target.test.mjs`, `tests/ssh-protocol.test.mjs`, `tests/ssh-target.test.mjs`, `tests/worker.test.mjs`: `codexHome` regressions.
- Create `tests/fixtures/stateful-fake-codex.mjs`: auth-file-aware fake CLI.
- Create `scripts/lib/remote-acceptance.mjs`: OpenSSH lifecycle and cleanup helpers.
- Create `scripts/e2e-remote-ssh.mjs`: synthetic and real-auth acceptance executable.
- Create `tests/remote-acceptance.test.mjs`: helper and synthetic OpenSSH tests.
- Create `scripts/lib/benchmark.mjs`: percentile and budget evaluation.
- Create `scripts/benchmark.mjs`: MCP release-bundle benchmark.
- Create `tests/benchmark.test.mjs`: deterministic benchmark-math tests.
- Modify `package.json`, `package-lock.json`, `.github/workflows/ci.yml`: scripts and CI gates.
- Modify `README.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`, `src/version.ts`: release 1.4.0 documentation and metadata.
- Regenerate `bundle/server.mjs`, `bundle/worker.mjs`.

### Task 1: Remove runtime-dead update and duplicate redaction logic

**Files:**
- Create: `tests/redundancy.test.mjs`
- Delete: `src/plugin.ts`
- Delete: `tests/plugin.test.mjs`
- Modify: `src/runtime/redaction.ts`

- [ ] **Step 1: Write the failing structural test**

```js
test("obsolete plugin self-update implementation is absent", () => {
  assert.equal(existsSync("src/plugin.ts"), false);
  assert.equal(existsSync("tests/plugin.test.mjs"), false);
});

test("runtime redaction delegates to the canonical redactor", () => {
  const source = readFileSync("src/runtime/redaction.ts", "utf8");
  assert.match(source, /redactText/);
  assert.doesNotMatch(source, /new RegExp|Authorization\\s|PRIVATE KEY/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/redundancy.test.mjs`

Expected: both tests fail because the obsolete files and parallel regex rules exist.

- [ ] **Step 3: Implement the minimum cleanup**

Delete both obsolete files. Replace `src/runtime/redaction.ts` with:

```ts
import { redactText } from "../redact.js";

/** Backward-compatible log redaction entry point backed by the canonical engine. */
export function redact(value: string): string {
    return redactText(value);
}
```

- [ ] **Step 4: Verify GREEN and regression behavior**

Run: `npm run build && node --test tests/redundancy.test.mjs tests/security.test.mjs tests/security-boundaries.test.mjs`

Expected: all tests pass and query-token, bearer, assignment and private-key canaries remain redacted.

- [ ] **Step 5: Commit**

```bash
git add -A src/plugin.ts src/runtime/redaction.ts tests/plugin.test.mjs tests/redundancy.test.mjs
git commit -m "refactor: remove obsolete update and redaction code"
```

### Task 2: Propagate remote CODEX_HOME through every Codex process

**Files:**
- Create: `tests/fixtures/stateful-fake-codex.mjs`
- Modify: `tests/local-target.test.mjs`
- Modify: `tests/ssh-protocol.test.mjs`
- Modify: `tests/worker.test.mjs`
- Modify: `src/codex.ts`
- Modify: `src/execution/local-target.ts`
- Modify: `src/execution/ssh/protocol.ts`
- Modify: `src/execution/ssh/target.ts`
- Modify: `src/execution/registry.ts`
- Modify: `src/worker/operations.ts`

- [ ] **Step 1: Create the stateful fake Codex fixture**

The executable must implement `--version`, `login status`, `login --with-access-token`, and `exec`. `login status` succeeds only when `$CODEX_HOME/auth.json` exists. It must never print credential contents.

- [ ] **Step 2: Write failing local target tests**

```js
const target = new LocalExecutionTarget({ codexBin: fake, codexHome });
assert.equal((await target.doctor()).state, "unhealthy");
writeFileSync(join(codexHome, "auth.json"), "synthetic", { mode: 0o600 });
assert.equal((await target.doctor()).state, "healthy");
```

Add a slice assertion that the fake Codex reports normal completion only with the same custom `codexHome`.

- [ ] **Step 3: Write failing protocol and worker tests**

Doctor and `codex.run` requests without `codexHome` must fail schema parsing. Requests with an absolute or `~/` value must pass. Worker doctor and slice must observe the requested home.

- [ ] **Step 4: Verify RED**

Run: `npm run build && node --test tests/local-target.test.mjs tests/ssh-protocol.test.mjs tests/worker.test.mjs`

Expected: constructor/protocol assertions fail because `codexHome` is not propagated.

- [ ] **Step 5: Implement explicit environment propagation**

Add `codexHome?: string` to `RunSliceOptions` and `LocalExecutionTargetOptions`. Build the Codex child environment once and override `CODEX_HOME` only when defined. Add `codexHome` to worker doctor and Codex request schemas. Store it in `SshExecutionTargetOptions`, send it with both operations, pass it from the registry, and instantiate worker-local targets with it.

- [ ] **Step 6: Verify GREEN**

Run: `npm run build && node --test tests/local-target.test.mjs tests/ssh-protocol.test.mjs tests/worker.test.mjs tests/ssh-target.test.mjs`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/codex.ts src/execution src/worker/operations.ts tests/fixtures/stateful-fake-codex.mjs tests/local-target.test.mjs tests/ssh-protocol.test.mjs tests/worker.test.mjs tests/ssh-target.test.mjs
git commit -m "fix: honor persistent remote Codex home"
```

### Task 3: Add a real OpenSSH restart and auth-persistence acceptance test

**Files:**
- Create: `scripts/lib/remote-acceptance.mjs`
- Create: `scripts/e2e-remote-ssh.mjs`
- Create: `tests/remote-acceptance.test.mjs`

- [ ] **Step 1: Write failing helper tests**

Test that prerequisite discovery rejects missing binaries, allocated ports are in the non-privileged range, and cleanup terminates registered children and removes the temporary root.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/remote-acceptance.test.mjs`

Expected: module-not-found failure for `scripts/lib/remote-acceptance.mjs`.

- [ ] **Step 3: Implement lifecycle helpers**

Export typed JSDoc functions for binary discovery, free-port allocation, bounded command execution, ephemeral key generation, `sshd` startup readiness, known-host enrollment and idempotent cleanup. All spawned commands use argv arrays and no shell.

- [ ] **Step 4: Implement the synthetic acceptance executable**

Start `sshd`, initialize separate local/remote Git repositories, configure a temporary SSH home, deploy the real worker bundle, bootstrap synthetic auth, run doctor and one fake Codex slice, construct a new target, delete the local source credential, and verify the new target remains healthy.

- [ ] **Step 5: Implement `--real-auth` mode**

Resolve the actual Codex binary and private source with the existing `loadCredentialFile` guard. Copy credentials only through `RemoteAuthBootstrapper`; verify two independent doctors against the temporary remote `codexHome`; skip the model slice; redact all reported data.

- [ ] **Step 6: Verify GREEN**

Run: `npm run bundle && node --test tests/remote-acceptance.test.mjs`

Run: `node scripts/e2e-remote-ssh.mjs`

Run: `node scripts/e2e-remote-ssh.mjs --real-auth`

Expected: all three commands pass, report no credential values, stop `sshd`, and remove temporary roots.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/remote-acceptance.mjs scripts/e2e-remote-ssh.mjs tests/remote-acceptance.test.mjs
git commit -m "test: verify remote auth across OpenSSH restarts"
```

### Task 4: Add measurable MCP efficiency budgets

**Files:**
- Create: `scripts/lib/benchmark.mjs`
- Create: `scripts/benchmark.mjs`
- Create: `tests/benchmark.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing benchmark-math tests**

```js
assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
assert.deepEqual(evaluateBudgets({ serverBytes: 2_000_000 }, DEFAULT_BUDGETS).ok, false);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/benchmark.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement benchmark math and report schema**

Export `percentile`, `summarize`, `DEFAULT_BUDGETS`, and `evaluateBudgets`. Reject empty/non-finite samples and unknown metrics.

- [ ] **Step 4: Implement MCP benchmark executable**

Run seven isolated bundle processes with `ORCH_CODEX_BIN` set to the fake Codex. Measure connect plus `listTools`, then doctor. Print a single JSON report containing environment, samples, summaries, sizes, budgets and violations; exit 1 on violations.

- [ ] **Step 5: Verify GREEN**

Run: `npm run bundle && node --test tests/benchmark.test.mjs && node scripts/benchmark.mjs`

Expected: unit tests pass and all budgets pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/lib/benchmark.mjs scripts/benchmark.mjs tests/benchmark.test.mjs
git commit -m "perf: enforce MCP release budgets"
```

### Task 5: Release integration, documentation and CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `src/version.ts`
- Modify: `bundle/server.mjs`
- Modify: `bundle/worker.mjs`

- [ ] **Step 1: Add CI gates**

After bundle verification, run `npm run benchmark`. On macOS development hosts the OpenSSH test is mandatory; CI retains protocol and fake-SSH coverage unless the runner provides `sshd`.

- [ ] **Step 2: Document exact commands and guarantees**

README must distinguish protocol tests, synthetic real-OpenSSH acceptance, and real-auth acceptance. It must state that `--real-auth` does not execute a model turn and cleans temporary credentials.

- [ ] **Step 3: Set version 1.4.0 consistently**

Run: `npm version 1.4.0 --no-git-tag-version`

Update plugin manifest and runtime version to `1.4.0`; add changelog entry.

- [ ] **Step 4: Regenerate bundles**

Run: `npm run bundle`

- [ ] **Step 5: Run full release gates**

```bash
npm ci
npm run typecheck
npm test
npm run bundle
npm run verify:bundle
npm run benchmark
node scripts/e2e-remote-ssh.mjs
node scripts/e2e-remote-ssh.mjs --real-auth
node scripts/bundlecheck.mjs
claude plugin validate . --strict
npm audit --audit-level=moderate
git diff --check origin/main...HEAD
```

Expected: every command exits 0; no temporary SSH process or directory remains.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml README.md CHANGELOG.md package.json package-lock.json .claude-plugin/plugin.json src/version.ts bundle
git commit -m "release: prepare production-complete plugin 1.4.0"
```

### Task 6: Review, publish, merge and reinstall

**Files:**
- No source changes unless review or CI identifies a reproducible defect.

- [ ] **Step 1: Self-review the full branch diff**

Search for dead imports, duplicated secret patterns, shell execution, credential output, unbounded child processes and stale version strings.

- [ ] **Step 2: Push and create a ready PR**

Push `codex/close-production-gaps`; create a non-draft PR to `main` with test evidence.

- [ ] **Step 3: Wait for required CI**

Run: `gh pr checks <number> --watch --interval 5`

Expected: all required checks pass.

- [ ] **Step 4: Merge and synchronize main**

Merge through GitHub, switch the primary checkout to `main`, and fast-forward from `origin/main`.

- [ ] **Step 5: Remove and reinstall the marketplace plugin**

```bash
claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes
claude plugin marketplace update codex-orchestrator
claude plugin install codex-orchestrator@codex-orchestrator --scope user
```

- [ ] **Step 6: Verify installed artifact**

Require version 1.4.0, exactly two skills, connected plugin MCP, 17 tools,
healthy installed `orchestrator_doctor`, strict validation and installed-cache
bundle check.

- [ ] **Step 7: Clean owned worktree and merged branches**

Only after merge and installed verification, remove the Superpowers-owned
worktree, prune registrations and delete merged local/remote feature branches.
