# PR #33 Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize PR #33 as the behaviour-preserving, accurately documented ports-and-adapters baseline for issue #32 and stop at the operator's pre-merge checkpoint.

**Architecture:** Core/application consumers receive all concrete clock, identity, execution, and hypothesis-repository dependencies from composition. Session terminalization uses one path so the task row, events, and agent-job ledger cannot diverge. The architecture SSOT and documents name only boundaries that are enforced today; dynamic capability/module routing remains owned by issue #38.

**Tech Stack:** TypeScript 5.9, Node.js 24, Node test runner, SQLite, GitHub CLI/GraphQL, esbuild, MCP SDK.

## Global Constraints

- Work only on existing branch `claude/issue-32-hexagonal-refactor-uad6rq` and PR #33.
- Preserve the external MCP surface: 17 tools and 2 prompts with unchanged descriptions and input schemas.
- Preserve version `1.5.2`; no release or MCPB version bump.
- No SQLite schema change and no product feature.
- Every production-code change follows a witnessed RED → GREEN test cycle.
- No core/application consumer imports `system-clock.ts` or constructs `LocalExecutionTarget` as a hidden default.
- No plaintext secrets, weakened sandbox, network, audit, or review gates.
- Every task receives a fresh implementer and independent QA review.
- After every push, record exact head, hypothesis, counter-hypothesis, falsification check, and evidence on PR #33 before continuing.
- Do not merge. Stop after issue #32 reaches the verified pre-merge gate and report to the operator.

---

## File responsibility map

- `src/session.ts`: session lifecycle and the single terminalization path.
- `src/db.ts`: SQLite persistence adapter; requires `Clock` and `IdGenerator`.
- `src/hypotheses.ts`: hypothesis repository; requires `Clock` and `IdGenerator`.
- `src/artifact.ts`: result-artifact assembly using an injected `HypothesisRepo`.
- `src/app/context.ts`: production composition of concrete adapters.
- `tests/helpers/system-deps.mjs`: explicit test-only system composition helpers.
- `tests/session-limits.test.mjs`: limit-breach ledger regression.
- `tests/architecture-boundary.test.mjs`: structural dependency and documentation contracts.
- `ssot/architecture.json`: machine-readable current architecture classification.
- `docs/architecture.md`, `docs/ports-and-adapters.md`, `docs/module-reference.md`: accurate maintainer-facing boundaries.

### Task 1: Make dependency inversion structural

**Files:**
- Create: `tests/helpers/system-deps.mjs`
- Modify: `src/db.ts`
- Modify: `src/hypotheses.ts`
- Modify: `src/session.ts`
- Modify: `src/artifact.ts`
- Modify: `src/app/context.ts`
- Modify: `src/app/tools/planning.ts`
- Modify: `tests/architecture-boundary.test.mjs`
- Modify: `tests/artifact.test.mjs`
- Modify: `tests/clock-injection.test.mjs`
- Modify: `tests/cluster-gate.test.mjs`
- Modify: `tests/config-agents.test.mjs`
- Modify: `tests/gate.test.mjs`
- Modify: `tests/hypotheses.test.mjs`
- Modify: `tests/hypothesis-update.test.mjs`
- Modify: `tests/isolation.test.mjs`
- Modify: `tests/migrations.test.mjs`
- Modify: `tests/persistence.test.mjs`
- Modify: `tests/security.test.mjs`
- Modify: `tests/statemachine.test.mjs`

**Interfaces:**
- Consumes: `Clock`, `IdGenerator`, `ExecutionTarget`, `PersistenceStore`.
- Produces: required constructors
  - `new Store(dbPath: string, clock: Clock, ids: IdGenerator)`
  - `new HypothesisRepo(store: PersistenceStore, clock: Clock, ids: IdGenerator)`
  - `new SessionManager(store: PersistenceStore, targetFor: (id: string) => ExecutionTarget, ids: IdGenerator, clock: Clock)`
  - `buildResultArtifact(store: PersistenceStore, hyp: HypothesisRepo, planId: string, opts?: ArtifactOptions)`
  - `writeResultArtifact(store: PersistenceStore, hyp: HypothesisRepo, planId: string, opts?: ArtifactOptions)`

- [ ] **Step 1: Extend the boundary test so current hidden defaults fail**

Add this test to `tests/architecture-boundary.test.mjs`:

```js
test("core consumers cannot import concrete clock or execution adapters", () => {
    for (const consumer of manifest.clockConsumers) {
        for (const spec of importsOf(consumer)) {
            assert.ok(
                !forbids(spec, "system-clock"),
                `${consumer} must receive Clock/IdGenerator from composition (${spec})`,
            );
        }
    }
    const sessionImports = importsOf("src/session.ts");
    assert.ok(
        sessionImports.every((spec) => !forbids(spec, "local-target")),
        "SessionManager must receive ExecutionTarget lookup from composition",
    );
});
```

- [ ] **Step 2: Run the boundary test and witness RED**

Run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 24
npm run build
node --test tests/architecture-boundary.test.mjs
```

Expected: FAIL because `src/db.ts`, `src/hypotheses.ts`, and `src/session.ts` import `system-clock`, and `src/session.ts` imports `execution/local-target`.

- [ ] **Step 3: Add explicit test composition helpers**

Create `tests/helpers/system-deps.mjs`:

```js
import { Store } from "../../dist/db.js";
import { HypothesisRepo } from "../../dist/hypotheses.js";
import { SessionManager } from "../../dist/session.js";
import { LocalExecutionTarget } from "../../dist/execution/local-target.js";
import { systemClock, systemIdGenerator } from "../../dist/system-clock.js";

/** @typedef {import("../../dist/ports/persistence.js").PersistenceStore} PersistenceStore */

/** @param {string} dbPath */
export function createSystemStore(dbPath) {
    return new Store(dbPath, systemClock, systemIdGenerator);
}

/** @param {PersistenceStore} store */
export function createSystemHypothesisRepo(store) {
    return new HypothesisRepo(store, systemClock, systemIdGenerator);
}

/**
 * @param {PersistenceStore} store
 * @param {(id: string) => import("../../dist/execution/types.js").ExecutionTarget} [targetFor]
 */
export function createSystemSessionManager(store, targetFor) {
    const local = new LocalExecutionTarget();
    return new SessionManager(
        store,
        targetFor ?? (() => local),
        systemIdGenerator,
        systemClock,
    );
}
```

Update direct test construction to use these helpers. Tests that inject fake clocks/IDs keep direct constructors so they continue proving the seam.

- [ ] **Step 4: Remove concrete defaults and inject the artifact repository**

Change the constructors to required dependencies:

```ts
// src/db.ts
constructor(
  dbPath: string,
  private readonly clock: Clock,
  private readonly ids: IdGenerator,
) { /* existing body */ }

// src/hypotheses.ts
constructor(
  private store: PersistenceStore,
  private readonly clock: Clock,
  private readonly ids: IdGenerator,
) {}

// src/session.ts
constructor(
  private store: PersistenceStore,
  private readonly targetFor: (id: string) => ExecutionTarget,
  private readonly ids: IdGenerator,
  private readonly clock: Clock,
) {
  this.emitter.setMaxListeners(0);
}
```

Remove production imports of `systemClock`, `systemIdGenerator`, and
`LocalExecutionTarget` from those consumers.

Change artifact assembly:

```ts
export function buildResultArtifact(
  store: PersistenceStore,
  hyp: HypothesisRepo,
  planId: string,
  opts: ArtifactOptions = {},
): ResultArtifact | null {
  const plan = store.getPlan(planId);
  if (!plan) return null;
  const repo = plan.repo_path;
}
```

Delete the existing `const hyp = new HypothesisRepo(store);` line. The existing
`const clusters = ...` statement follows `const repo = plan.repo_path;`
directly; every later `hyp.listVersions()` call uses the injected parameter.

Apply the same injected `hyp` parameter to `writeResultArtifact()` and call
`buildResultArtifact(store, hyp, planId, opts)`. In
`src/app/tools/planning.ts`, destructure `hypRepo` from `AppContext` and call:

```ts
const res = writeResultArtifact(store, hypRepo, a.plan_id, {
  originalUserRequest: a.original_request,
  interpretedGoal: a.interpreted_goal,
  finalAssessment: a.final_assessment,
  recommendedNextSteps: a.recommended_next_steps,
  gitCommitBefore: a.git_commit_before ?? null,
});
```

Update `tests/artifact.test.mjs` and `tests/security.test.mjs` to pass their
explicitly composed `HypothesisRepo`. Keep production system adapter
construction exclusively in `src/app/context.ts`.

- [ ] **Step 5: Run targeted tests and witness GREEN**

Run:

```bash
npm run build
node --test tests/architecture-boundary.test.mjs tests/clock-injection.test.mjs tests/artifact.test.mjs tests/hypotheses.test.mjs tests/isolation.test.mjs
```

Expected: all targeted tests pass; the boundary test reports no concrete adapter imports from the declared consumers.

- [ ] **Step 6: Run the complete suite**

Run: `npm test`

Expected: 225 passed, 2 skipped, 0 failed or a higher passing count caused only by new tests.

- [ ] **Step 7: Commit the reviewed task**

```bash
git add src tests
git commit -m "refactor: require composed runtime dependencies"
```

### Task 2: Close the agent-job ledger on limit breach

**Files:**
- Create: `tests/session-limits.test.mjs`
- Modify: `src/session.ts`

**Interfaces:**
- Consumes: the explicit `SessionManager` constructor from Task 1.
- Produces: a limit-breach terminal transition that closes both task and job state.

- [ ] **Step 1: Write the failing ledger regression**

Create `tests/session-limits.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { SessionManager } from "../dist/session.js";

test("limit breach closes the task and its open agent job", () => {
    const fixed = "2026-07-11T12:00:00.000Z";
    const clock = { now: () => fixed };
    const ids = { newId: (prefix) => `${prefix}_limit` };
    const store = new Store(
        join(mkdtempSync(join(tmpdir(), "orch-limit-")), "state.sqlite"),
        clock,
        ids,
    );
    const target = { id: "fake", kind: "local" };
    const sessions = new SessionManager(store, () => target, ids, clock);
    const task = sessions.createTask({
        clusterId: null,
        repoPath: "/repo",
        worktree: null,
        branch: null,
        instructions: "test",
        acceptance: [],
        sandbox: "read-only",
        model: "auto",
        effort: "low",
        network: false,
        maxMinutes: 1,
    });
    store.recordAgentJob({
        taskId: task.id,
        clusterId: null,
        hypothesisId: null,
        model: "auto",
        effort: "low",
        sandbox: "read-only",
        status: "queued",
    });

    sessions.limitBreach(task.id, "maxTaskMinutes exceeded");

    assert.deepEqual(
        { status: store.getTask(task.id)?.status, endedAt: store.getTask(task.id)?.ended_at },
        { status: "blocked", endedAt: fixed },
    );
    const job = store.listAgentJobs({ taskId: task.id }).at(-1);
    assert.equal(job.status, "blocked");
    assert.equal(job.ended_at, fixed);
    assert.equal(job.summary, "maxTaskMinutes exceeded");
    assert.deepEqual(
        store.eventsAfter(task.id, 0).map((event) => event.kind),
        ["limit_breach", "task_status"],
    );
});
```

The TypeScript `private` method is emitted as the named JavaScript method
`limitBreach`, so the `.mjs` regression calls it directly without changing the
package or MCP surface.

- [ ] **Step 2: Run the regression and witness RED**

Run:

```bash
npm run build
node --test tests/session-limits.test.mjs
```

Expected: FAIL because the agent job remains `queued` with `ended_at === null`.

- [ ] **Step 3: Route limit breaches through the terminalization path**

Implement:

```ts
limitBreach(taskId: string, reason: string): void {
  this.store.addEvent(taskId, "limit_breach", { reason });
  this.finish(taskId, "blocked", reason);
}
```

Keep the event order `limit_breach` then `task_status`. Do not duplicate the
task/job terminalization statements.

- [ ] **Step 4: Run targeted and lifecycle tests**

Run:

```bash
npm run build
node --test tests/session-limits.test.mjs tests/isolation.test.mjs tests/clock-injection.test.mjs tests/persistence.test.mjs
```

Expected: all tests pass and the new test observes the fixed clock on both task and job rows.

- [ ] **Step 5: Run the complete suite**

Run: `npm test`

Expected: all tests pass with 0 failures.

- [ ] **Step 6: Commit the reviewed task**

```bash
git add src/session.ts tests/session-limits.test.mjs
git commit -m "fix: close blocked agent jobs on limit breach"
```

### Task 3: Align architecture SSOT, contracts, and documentation

**Files:**
- Modify: `ssot/architecture.json`
- Modify: `ssot/index.toml`
- Modify: `tests/architecture-boundary.test.mjs`
- Modify: `docs/architecture.md`
- Modify: `docs/ports-and-adapters.md`
- Modify: `docs/module-reference.md`
- Modify: `README.md` only if it repeats a corrected architecture claim

**Interfaces:**
- Consumes: structural dependency rules from Tasks 1–2.
- Produces: one honest, contract-tested classification and documented issue-#38 boundary.

- [ ] **Step 1: Change the contract test to require the accurate classification**

Replace `domainPure` assertions with `corePortConsumers` assertions:

```js
test("the manifest is internally consistent", () => {
    assert.equal(manifest.adapters.persistence, "src/db.ts");
    assert.equal(manifest.ports.persistence, "src/ports/persistence.ts");
    assert.ok(manifest.persistenceConsumers.length >= 8);
    for (const consumer of manifest.corePortConsumers) {
        assert.ok(
            manifest.persistenceConsumers.includes(consumer),
            `${consumer} is a core port consumer but not a persistence consumer`,
        );
    }
});

test("infrastructure-independent core modules import ports but no concrete I/O", () => {
    for (const consumer of manifest.corePortConsumers) {
        assert.ok(
            importsOf(consumer).some((spec) => spec.includes("ports/")),
            `${consumer} must express infrastructure needs through a port`,
        );
        for (const spec of importsOf(consumer)) {
            for (const forbidden of manifest.forbiddenCoreImports) {
                assert.ok(!forbids(spec, forbidden), `${consumer} must not import concrete I/O (${spec})`);
            }
        }
    }
});
```

Extend the document contract to assert that:

- `docs/module-reference.md` classifies `hypotheses.ts` as a repository/DAO;
- `docs/architecture.md` names the three established port groups;
- `docs/ports-and-adapters.md` links issue #38 for dynamic module communication;
- the docs do not state that every infrastructure dependency is already ported.

- [ ] **Step 2: Run the architecture test and witness RED**

Run:

```bash
npm run build
node --test tests/architecture-boundary.test.mjs
```

Expected: FAIL because the SSOT still uses `domainPure` and the documents do not yet satisfy the new truth contract.

- [ ] **Step 3: Update the architecture SSOT**

In `ssot/architecture.json`:

```json
"corePortConsumers": [
  "src/statemachine.ts",
  "src/prompts.ts",
  "src/resolve.ts"
],
"forbiddenCoreImports": [
  "node:sqlite",
  "sqlite",
  "node:fs",
  "fs",
  "node:child_process",
  "child_process",
  "node:os",
  "os",
  "system-clock",
  "execution/local-target"
]
```

Remove the misleading `domainPure` name and update the explanatory SSOT notes.
Record `src/execution/registry.ts` as a feature-local composition root while
retaining `src/server.ts` and `src/app/context.ts` as the application bootstrap
roots.

- [ ] **Step 4: Correct all maintainer documents**

Use these exact distinctions consistently:

- “infrastructure-independent core services” for `statemachine`, `prompts`, and `resolve`;
- “repository/DAO” for `HypothesisRepo`;
- “application bootstrap composition roots” for `server.ts` and `app/context.ts`;
- “execution feature composition root” for `execution/registry.ts`;
- “established ports: persistence, clock/id, execution”;
- “dynamic discovery, capability routing, and named module-communication contracts are follow-up scope in issue #38.”

Delete or narrow claims that filesystem, MCP, worktree, review, updater, and
every other infrastructure concern are already interchangeable ports.

- [ ] **Step 5: Run architecture and documentation contracts**

Run:

```bash
npm run build
node --test tests/architecture-boundary.test.mjs tests/readme-contract.test.mjs tests/ssot.test.mjs
```

Expected: all tests pass and no document contradicts the SSOT.

- [ ] **Step 6: Run the complete suite**

Run: `npm test`

Expected: all tests pass with 0 failures.

- [ ] **Step 7: Commit the reviewed task**

```bash
git add ssot/architecture.json tests/architecture-boundary.test.mjs docs/architecture.md docs/ports-and-adapters.md docs/module-reference.md README.md
git commit -m "docs: align architecture claims with enforced ports"
```

### Task 4: Exact-head verification and PR closure evidence

**Files:**
- Modify: PR #33 body and review threads through GitHub APIs
- Do not modify production files unless QA returns a verified finding

**Interfaces:**
- Consumes: reviewed commits from Tasks 1–3.
- Produces: exact-head evidence, resolved threads, final QA disposition, and pre-merge report.

- [ ] **Step 1: Run the complete local quality gate**

Run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 24
npm run typecheck
npm test
npm run test:coverage
npm run bundle
npm run verify:bundle
npm run mcpb:validate
npm run mcpb:build
npm run mcpb:verify
npm run benchmark
npm audit --audit-level=high
git diff --check origin/main...HEAD
```

Expected: every command exits 0; coverage remains at or above 75 % lines, 70 % branches, and 75 % functions.

- [ ] **Step 2: Generate a whole-branch review package and dispatch clean-context QA**

Use the merge base `9d7bb09a4f617db922a9e3aa0da475b5517eb0b1` and current `HEAD`. The reviewer must inspect issue #32 acceptance, the finalization design, all source/test/doc changes, architectural truthfulness, security, and regression risk. Every finding must state severity, exact file/line, failing scenario, and required evidence.

- [ ] **Step 3: Process QA findings test-first**

For every Critical or Important finding:

1. reproduce with a failing targeted test;
2. implement one fix;
3. rerun targeted and full verification;
4. re-review the updated diff.

Do not proceed while any Critical or Important finding remains.

- [ ] **Step 4: Push the exact reviewed head and record the hypothesis gate**

```bash
git push origin HEAD:claude/issue-32-hexagonal-refactor-uad6rq
```

Post the required head/hypothesis/counter-hypothesis/falsification/evidence record on PR #33 before any further work.

- [ ] **Step 5: Wait for and verify exact-head CI**

Run:

```bash
gh pr checks 33 --repo tomtastisch/codex-orchestrator --watch
```

Expected: every required check succeeds; release may be skipped by policy.

- [ ] **Step 6: Reply to and resolve the limit-breach thread with evidence**

Reply in the existing inline thread with the exact fix commit, regression test
name, targeted test result, full-suite result, and exact-head CI result. Resolve
only after all evidence exists.

- [ ] **Step 7: Update the PR body and read back the merge gate**

Update the PR body with exact head, current test/coverage counts, scope/non-goals,
QA review result, and truthful unresolved-thread count. Then query GraphQL and
verify unresolved review threads equal zero.

- [ ] **Step 8: Stop at the issue-level pre-merge checkpoint**

Report:

- exact head SHA;
- commits introduced in this finalization;
- all verification commands and results;
- QA disposition;
- GitHub check state;
- unresolved-thread count;
- issue #32 acceptance mapping;
- remaining follow-up issues and dependencies.

Do not merge until the operator receives this report.
