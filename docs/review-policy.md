# Review & Merge Policy

Codex Orchestrator treats review as a hard gate, not a courtesy. This document
describes the layered review model — GitHub Copilot as the primary automated
reviewer, and a mandatory independent Claude-internal QA agent as the
fail-closed fallback — plus the exact-head merge gate and the release policy.

The binding rules for coding agents live in [`../CLAUDE.md`](../CLAUDE.md)
(Claude, orchestrator/reviewer) and [`../AGENTS.md`](../AGENTS.md) (Codex,
executor). GitHub Copilot's review instructions live in
[`../.github/copilot-instructions.md`](../.github/copilot-instructions.md).

## The review layers

1. **Automated CI gate** — every pull request runs the portable matrix, the
   quality gate (typecheck, tests, coverage floors, bundle/MCPB verification,
   benchmark), CodeQL and `npm audit`. Review is requested only after CI is green
   and is bound to the pull request's **exact-head** commit; a stale-head review
   never authorizes a merge.

2. **GitHub Copilot review (primary)** — when available and configured, Copilot
   reviews the exact head as an additional safety layer.

3. **Independent QA agent (fallback, fail-closed)** — a read-only, clean-context,
   chat-free Claude-internal QA agent. It is **mandatory** and becomes the only
   permitted alternative review path whenever Copilot cannot deliver an
   exact-head review for any of these reasons:
   - Copilot is **not installed or not configured** for the repository;
   - the Copilot review **limit or quota is reached** (operator-attested);
   - Copilot is **unreachable** (no connection / API failure).

   In every such case the independent agent fully **replaces** Copilot for that
   pull request (it does not run in addition). Quota exhaustion is classified
   only from explicit provider or operator evidence — API silence or an absent
   review is never treated as quota evidence; the fail-closed default is
   `unavailable/unknown`.

   When the fallback is used, the pull request must record **why** (which of the
   three triggers applied and the evidence). Transient state — e.g. "Copilot
   quota is currently reached" — belongs in the pull request or a status issue,
   **not** in this document, which states only the durable rules.

## The merge gate

1. Request review only after green CI, bound to the exact-head commit.
2. The reviewer authors **every finding as a separate, unresolved PR review
   thread**. Chat-only findings do not satisfy the gate.
3. The executor processes each thread **test-first**: reproduce, fix, and post an
   in-thread reply with commit, test and CI evidence before resolving it.
   Evidence-backed disagreement is recorded in the same thread before resolution.
4. After every correction round, a **fresh exact-head review** is required.
5. Merge only when the reviewer approves the exact head, all required checks are
   green, and there are **zero unresolved review threads** (the count is read
   back immediately before merge).

## Release policy

- Exactly one current stable GitHub release and one corresponding version tag
  exist at a time; the latest artifact is always at
  [`releases/latest`](https://github.com/tomtastisch/codex-orchestrator/releases/latest).
  History stays auditable in `CHANGELOG.md` and Git, not as parallel installable
  versions.
- Every pull request's `quality` job publishes its verified MCPB, SHA-256
  checksum and `coverage/summary.txt` as one commit-addressed GitHub Actions
  artifact (7-day retention). These review artifacts are not releases.
- After a version change reaches `main`, the release workflow waits for the
  portable, quality and remote-acceptance jobs, rebuilds and verifies the release
  artifacts, publishes the new version, removes superseded releases and tags,
  marks the new release latest, and checks the one-release/one-tag invariant.

The policy is contract-tested: `tests/review-policy.test.mjs` binds the three
Copilot-fallback triggers, and `tests/release-policy.test.mjs` binds the release
workflow invariants.
