# Distribution, Release and README Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Goal: Enforce one current GitHub release and make all public distribution documentation match version 1.5.2 and the implemented runtime behavior.

Architecture: Contract tests derive documentation claims from source manifests and server registrations. A serialized GitHub Actions workflow publishes only version changes merged to `main`, then prunes obsolete releases and version tags. README and submission records use official Anthropic terminology and keep community directories explicitly separate.

Tech stack: Node.js 22, node:test, GitHub Actions, GitHub CLI, Claude Code plugin manifests, MCPB.

---

### Task 1: Lock the desired documentation and release behavior

Files:
- Modify: `tests/readme-contract.test.mjs`
- Create: `tests/release-policy.test.mjs`

- [ ] Add failing assertions for the released Desktop state, current version,
  latest-release URL, Anthropic community route, directory distinctions,
  registered prompts/tools and the one-release statement.
- [ ] Add failing structural tests for a serialized, version-change-triggered
  release workflow with release pruning and final invariant verification.
- [ ] Run both tests and confirm they fail for the missing behavior.

### Task 2: Implement deterministic single-release publishing

Files:
- Create: `.github/workflows/release.yml`

- [ ] Compare `package.json` with the current GitHub release/tag state, select
  no-op, cleanup or publish mode, enforce tag immutability and safely resume a
  partially completed release for the same commit.
- [ ] Run the complete release gate set and build the MCPB plus checksum.
- [ ] Publish the versioned release, prune older releases and semantic-version
  tags, set the new release as latest and assert exactly one remains.
- [ ] Run the release-policy test and confirm it passes.

### Task 3: Reconcile README and distribution records

Files:
- Modify: `README.md`
- Modify: `docs/distribution/anthropic-plugin-submission.md`

- [ ] Replace stale platform status and hard-coded release links.
- [ ] Separate prerequisites by runtime and preserve the zero-config Desktop
  installation flow.
- [ ] Document first-party installation, Anthropic community submission,
  official curation, community discovery and the one-release policy.
- [ ] Reconcile prompts, tools, authentication, update behavior and manual
  Desktop acceptance wording with the code.
- [ ] Run README contract tests and confirm they pass.

### Task 4: Verify, review and publish

Files:
- Modify: `CHANGELOG.md`

- [ ] Record the documentation and release-governance change.
- [ ] Run typecheck, all tests, both bundles, MCPB validation/build/verification,
  benchmark, bundle checks, strict Claude plugin validation and npm audit.
- [ ] Commit, push and open a PR.
- [ ] Wait for green CI and a Copilot review of the current head commit; address
  every actionable finding and repeat until both remain green.
- [ ] Merge, update `main`, verify its CI and confirm the single-release state.

### Task 5: Publish external discovery entries

Files:
- External catalogs only; no duplicated plugin source.

- [ ] Submit a metadata-only Build with Claude contribution that references the
  canonical GitHub repository.
- [ ] Request or await Cross AI Tools crawler inclusion using its documented
  discovery/contact route.
- [ ] Submit to Anthropic `claude-community` after account authentication is
  available; never claim `claude-plugins-official` inclusion without evidence.
