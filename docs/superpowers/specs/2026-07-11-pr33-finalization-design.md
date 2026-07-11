# PR #33 Finalization Design

Status: approved by operator-delegated decision authority on 2026-07-11

## Purpose

Finalize PR #33 as the behaviour-preserving implementation of issue #32. The
pull request must establish and accurately describe the current ports-and-
adapters baseline without absorbing the later dynamic capability-platform work
tracked by issue #38.

This issue is the first active unit of the wider production-readiness program.
Finishing it does not redefine the whole project as complete. After PR #33 is
merged through its exact-head gate, the remaining issue graph must be reconciled
and executed in dependency order until the repository's documented product,
architecture, security, distribution, and operational acceptance criteria are
all verified.

## Operator quality standard

The implementation is governed by these non-negotiable constraints:

- Evidence before action: inspect repository, logs, contracts, and runtime
  state; do not infer missing facts.
- Completeness means all decisions, dependencies, edge cases, types, tests, and
  documentation required by the selected issue are closed, not maximal prose.
- Structure precedes implementation: concept, architecture, implementation,
  and verification remain distinct and traceable.
- Automation is the default: repeatable commands and gates replace manual
  one-off steps wherever the repository can automate them.
- Security is fail-closed: no plaintext secrets, implicit credentials, or
  weakened sandbox/network boundaries.
- Direct criticism is required: implementers, reviewers, and the orchestrator
  must try to falsify their own conclusions instead of seeking agreement.
- No aesthetic refactoring outside the selected issue. Every changed line must
  serve a verified requirement, defect, contract, or documentation truth.

## Binding scope

The finalization has three implementation concerns:

1. Close the task and its `agent_jobs` ledger entry on a session limit breach.
2. Make dependency inversion structural at the seven changed seams: the
   `Store`, `HypothesisRepo`, and `SessionManager` constructors plus the
   `buildResultArtifact()`, `writeResultArtifact()`, `runChecks()`, and
   `diffSize()` helpers.
3. Align the architecture SSOT, boundary contracts, and maintainer documents
   with the boundary the code actually enforces.

The work does not add product features, change the MCP surface, change the
SQLite schema, bump the version, implement dynamic module discovery, or
implement capability routing. Those platform-level concerns remain in issue
#38 and later dedicated issues.

## Architecture decisions

### Terminal task transition

`SessionManager.limitBreach()` is a terminal transition. It must retain the
specific `limit_breach` event and then use the same terminalization path as
other blocked/failed/completed tasks. The resulting state must contain:

- task status `blocked`;
- task `ended_at` from the injected `Clock`;
- `limit_breach` and `task_status` events;
- the latest open `agent_jobs` row closed with status `blocked`, a non-null
  `ended_at`, and the limit reason as summary.

The regression test must first reproduce the current inconsistent ledger state
and fail before production code changes.

### Required dependency injection

The structural dependency-inversion claim is limited to `Store`,
`HypothesisRepo`, and `SessionManager` constructors plus
`buildResultArtifact()`, `writeResultArtifact()`, `runChecks()`, and
`diffSize()`.

`Store`, `HypothesisRepo`, and `SessionManager` constructors must not import
`systemClock`, `systemIdGenerator`, or `LocalExecutionTarget` to provide hidden
defaults. The artifact helpers receive an explicit `HypothesisRepo`. Production
wiring remains in `src/app/context.ts`. Tests must provide explicit fakes or the
system adapters through test helpers.

In `checks.ts`, `runChecks()` and `diffSize()` require explicit `ExecutionTarget`
arguments; they do not construct a hidden `LocalExecutionTarget` default.

The boundary contract must scan the declared clock/id consumers and fail if a
consumer imports the concrete clock/id adapter. It must also prevent
`SessionManager` and `checks.ts` from constructing a concrete execution adapter.

This decision changes internal construction only. It must not change tool
names, schemas, outputs, persisted data, or runtime selection semantics.

### Honest layer classification

`statemachine.ts` and `prompts.ts` are infrastructure-independent core services
that consume the persistence port; they are not pure functions. `resolve.ts` is an application service because it also imports concrete configuration and Git repository-boundary validation. The SSOT and documents must use these
classifications consistently. The boundary contract must prove that the core
services may import ports and domain types but do not import concrete I/O
adapters or ambient I/O modules.

Documentation must distinguish:

- established ports: persistence, clock/id, and execution;
- outer bootstrap/adapters: MCP transport and process lifecycle;
- concrete services not yet converted into independently discoverable dynamic
  modules;
- future capability/module communication work owned by issue #38.

No document may claim that every filesystem, MCP, review, worktree, or updater
dependency is already an interchangeable port when the code does not enforce
that claim.

## Verification strategy

Each implementation concern is test-driven and independently reviewed by a
fresh QA agent. Required checks are:

- targeted red/green regression for limit-breach ledger terminalization;
- targeted red/green boundary tests for forbidden concrete defaults;
- architecture-document/SSOT contract tests for consistent classification;
- `npm run typecheck`;
- `npm test`;
- `npm run test:coverage` with the existing 75/70/75 floors;
- `npm run bundle` and `npm run verify:bundle`;
- existing MCP surface parity test;
- exact-head GitHub checks and a clean-context final QA review.

## Push and hypothesis gate

Every push is one iteration. Before any work continues after a push, the
orchestrator must record on PR #33:

1. the exact pushed head SHA;
2. a hypothesis about what the iteration established;
3. a counter-hypothesis identifying how the conclusion could still be wrong;
4. the next concrete falsification check;
5. the verification evidence already available.

The next implementation iteration may start only after that record exists.

## GitHub review handling

The open `limitBreach()` review thread remains unresolved until the fix commit,
targeted regression result, and exact-head CI evidence are posted in that same
thread. Resolved or top-level findings are independently revalidated; valid
claim-integrity gaps are fixed without reopening unrelated issue scopes.

The PR body must state the exact current head, test evidence, and unresolved
thread count. It must not claim zero unresolved threads before the GraphQL
readback returns zero.

## Completion, merge, and reconciliation boundary

PR #33 is ready to merge only when:

- all three concerns above are implemented and independently reviewed;
- the full local verification suite is green;
- the branch is pushed and CI is green for the exact head;
- every actionable review thread has an evidence-backed reply and is resolved;
- a fresh clean-context QA reviewer explicitly approves the exact head;
- the unresolved-thread count is read back as zero.

After exact-head CI is green, an independent reviewer approves that exact head,
and the open review-thread count is zero, merge PR #33. After the merge,
reconcile the remaining issues and execute them in dependency order.
