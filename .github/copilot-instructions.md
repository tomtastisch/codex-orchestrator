# GitHub Copilot review instructions — codex-orchestrator

These instructions guide GitHub Copilot when it reviews pull requests in this
repository. They mirror the binding governance in [`../CLAUDE.md`](../CLAUDE.md)
and [`../AGENTS.md`](../AGENTS.md); the full review/merge gate is documented in
[`../docs/review-policy.md`](../docs/review-policy.md).

## What this project is

An MCP server that couples Claude (orchestrator/reviewer) with the Codex CLI
(executor) through a gated, checkpoint-slice workflow. The codebase has three
established port groups: persistence, clock/id, and execution. Their declared
consumers and adapters are recorded in `ssot/architecture.json`. Concrete
adapters for these seams are wired in the application bootstrap composition
roots `src/server.ts` and `src/app/context.ts`, or in the execution feature
composition root `src/execution/registry.ts`.

Port coverage is not repository-wide. In particular,
`src/app/tools/planning.ts` still depends directly on the concrete `worktree`,
`snapshot`, and `artifact` modules. These known dependencies are allowed by the
current architecture; moving them behind named module contracts is follow-up
[#38](https://github.com/tomtastisch/codex-orchestrator/issues/38), not a claim
reviewers should impose on this change.

## Review priorities

1. **Correctness first.** Flag real defects: wrong logic, unhandled errors,
   race conditions, broken state transitions, incorrect SQL, off-by-one and
   nullability bugs. Give a concrete failing scenario for each finding.
2. **Architecture boundaries.** Enforce the seams and consumer classifications
   declared in `ssot/architecture.json`; do not infer that every application
   dependency already has a port. Reject persistence consumers that import
   `db.js` or `node:sqlite`, declared clock/execution consumers that import their
   concrete adapters, raw `store.db` access outside the persistence adapter, and
   ambient I/O in a declared domain-pure module. New adapters for an established
   seam must implement its port. New tools use the injected `AppContext` for
   established context services; read-only process `config` and the recorded
   `worktree`/`snapshot`/`artifact` dependencies remain explicit exceptions
   pending #38. Do not expand those exceptions without updating the SSOT and its
   contract test.
3. **Security (fail-closed).** `danger-full-access` stays unreachable; slice
   network is off by default; `repo_check` runs allow-listed argv only; secrets
   (`auth.json`, tokens) are never logged, echoed in events/tool results, or
   committed. Per-task `extra_config` must stay behind its category blocklist.
   Governance-critical persistence (audit, agent-job ledger, hypothesis
   provenance) must never be silently swallowed — fail closed or surface a
   warning.
4. **Contracts & SSOT.** Central values live once under `ssot/` and are bound by
   contract tests — never hard-code a value that `ssot/` owns. The external MCP
   tool surface (17 tools, 2 prompts) must stay byte-identical unless the PR
   explicitly changes it.
5. **Tests.** Changes to production behaviour need tests; the coverage floors
   (75 % lines / 70 % branches / 75 % functions) must hold; boundary contract
   tests must stay green.

## How to file findings

- One finding per inline review thread, anchored to the exact file and line.
- Prefix severity: `[BLOCKER]` / `[MAJOR]` / `[MINOR]` / `[NIT]`.
- State the problem, a concrete failing scenario or why it matters, and a
  suggested direction. Do not invent findings to look busy; if the change is
  sound, say so.

## What not to do

- Do not request stylistic rewrites that the repository does not enforce (there
  is no Prettier/ESLint config; match the surrounding code).
- Do not approve a merge while any review thread is unresolved or CI is red.
- Do not treat an absent Copilot review as evidence of quota state.
