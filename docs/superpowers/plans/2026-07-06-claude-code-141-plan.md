# Claude Code 1.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a precise Claude Code 1.4.1 release whose README states the real prerequisites, support boundaries, installation lifecycle and marketplace status.

**Architecture:** Keep the working Claude Code plugin unchanged and make documentation claims executable through structural tests. Synchronize every version source, regenerate both bundles, reinstall from the first-party GitHub marketplace and prepare the official Anthropic submission without claiming approval before it occurs.

**Tech Stack:** Markdown, Node.js test runner, Claude Code plugin CLI, esbuild, GitHub CLI.

---

### Task 1: Lock the support matrix and prerequisite contract

**Files:**
- Create: `tests/readme-contract.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write the failing support-matrix test**

Create `tests/readme-contract.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");

test("README states the exact platform support status", () => {
    assert.match(readme, /Claude Code CLI\s*\|\s*Produktionsbereit/);
    assert.match(readme, /Claude Desktop MCPB[^\n]*\|\s*In Entwicklung/);
    assert.match(readme, /claude\.ai Remote MCP[^\n]*\|\s*In Entwicklung/);
    assert.match(readme, /Claude Desktop ist keine Voraussetzung/);
});

test("README lists executable prerequisites and lifecycle commands", () => {
    for (const command of [
        "node --version", "git --version", "codex --version", "codex login status",
        "claude --version", "claude plugin marketplace add tomtastisch/codex-orchestrator",
        "claude plugin install codex-orchestrator@codex-orchestrator --scope user",
        "claude plugin marketplace update codex-orchestrator",
        "claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes",
        "claude plugin list --json", "claude mcp list",
    ]) assert.ok(readme.includes(command), `README command missing: ${command}`);
});

test("README distinguishes first-party availability from Anthropic approval", () => {
    assert.match(readme, /First-party GitHub marketplace/);
    assert.match(readme, /not yet listed in the official Anthropic marketplace/i);
    assert.doesNotMatch(readme, /Official marketplace for the Codex Orchestrator/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/readme-contract.test.mjs`

Expected: FAIL because the matrix and complete command inventory are absent.

- [ ] **Step 3: Restructure the README introduction**

After the opening summary, add the exact matrix:

```markdown
## Platform support

| Runtime | Status | Installation |
|---|---|---|
| Claude Code CLI | Produktionsbereit | First-party GitHub marketplace |
| Claude Desktop MCPB | In Entwicklung | Planned for release 1.5.0 |
| claude.ai Remote MCP | In Entwicklung | Planned for release 1.6.0 |

This repository currently ships a Claude Code plugin. Claude Desktop is not a
prerequisite for that plugin, and claude.ai cannot start its local stdio server.
```

Replace `## Prerequisites` with checked commands and explicit login requirements:

```markdown
## Prerequisites

- Node.js ≥ 22.5: `node --version`
- Git: `git --version`
- Codex CLI: `codex --version`
- Active Codex login: `codex login status`
- Claude Code CLI installed locally: `claude --version`
- Active Claude Code login: start `claude` and complete its login flow

Never paste `auth.json`, OAuth tokens or API keys into Claude or a shell command.
```

- [ ] **Step 4: Document install, verify, update and removal**

Use separate numbered sections with these literal command blocks:

```bash
claude plugin marketplace add tomtastisch/codex-orchestrator
claude plugin install codex-orchestrator@codex-orchestrator --scope user
claude plugin list --json
claude mcp list
```

```bash
claude plugin marketplace update codex-orchestrator
```

```bash
claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes
```

Retain both invocations:

```text
/codex-orchestrator:codex-orchestrator Implement the requested change
/codex-orchestrator:orchestrator-status [plan_id]
```

- [ ] **Step 5: Verify GREEN**

Run: `npm run build && node --test tests/readme-contract.test.mjs tests/commands.test.mjs`

Expected: all README and command-contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add README.md tests/readme-contract.test.mjs
git commit -m "docs: define supported Claude runtimes"
```

### Task 2: Correct marketplace ownership and prepare submission

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Create: `docs/distribution/anthropic-plugin-submission.md`
- Modify: `tests/baseline.test.mjs`

- [ ] **Step 1: Write the failing marketplace-ownership assertion**

Add to `tests/baseline.test.mjs`:

```js
test("marketplace identifies itself as first-party, not Anthropic-official", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    assert.match(marketplace.description, /First-party/);
    assert.doesNotMatch(marketplace.description, /Official marketplace/i);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test --test-name-pattern="first-party" tests/baseline.test.mjs`

Expected: FAIL because the current description says `Official marketplace`.

- [ ] **Step 3: Correct the marketplace description**

Set `.claude-plugin/marketplace.json` field `description` to:

```json
"First-party marketplace maintained by the Codex Orchestrator project."
```

- [ ] **Step 4: Add the exact official-submission record**

Create `docs/distribution/anthropic-plugin-submission.md` with:

```markdown
# Anthropic plugin marketplace submission

Status: Prepared, not yet submitted

- Plugin: codex-orchestrator
- Repository: https://github.com/tomtastisch/codex-orchestrator
- First-party install command: `claude plugin marketplace add tomtastisch/codex-orchestrator`
- Official submission: https://claude.ai/settings/plugins/submit
- Alternative submission: https://platform.claude.com/plugins/submit

The repository may be described as submitted only after the form returns a
submission acknowledgement. It may be described as officially listed only
after it appears in `claude-plugins-official` or https://claude.com/plugins.
```

- [ ] **Step 5: Verify GREEN and strict manifest validation**

Run: `npm run build && node --test tests/baseline.test.mjs && claude plugin validate . --strict`

Expected: all baseline tests pass and validation prints `Validation passed`.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json docs/distribution/anthropic-plugin-submission.md tests/baseline.test.mjs
git commit -m "docs: clarify plugin marketplace ownership"
```

### Task 3: Prepare and verify release 1.4.1

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `src/version.ts`
- Modify: `CHANGELOG.md`
- Modify: `bundle/server.mjs`
- Modify: `bundle/worker.mjs`

- [ ] **Step 1: Bump package metadata**

Run: `npm version 1.4.1 --no-git-tag-version`

Set `.claude-plugin/plugin.json` version and `ORCHESTRATOR_VERSION` in
`src/version.ts` to `1.4.1`.

- [ ] **Step 2: Add the changelog entry**

Add:

```markdown
## 1.4.1 - 2026-07-06

### Documentation

- Added the exact Claude Code, Codex CLI and authentication prerequisites.
- Added install, verification, update and removal commands.
- Distinguished the first-party marketplace from Anthropic's official marketplace.
- Published the Claude Desktop MCPB and claude.ai Remote MCP roadmap.
```

- [ ] **Step 3: Regenerate release bundles**

Run: `npm run bundle`

Expected: both bundles build successfully and contain runtime version 1.4.1.

- [ ] **Step 4: Execute release gates**

Run sequentially:

```bash
npm ci
npm run typecheck
npm test
npm run verify:bundle
npm run benchmark
npm run test:remote
npm run test:remote:real
node scripts/bundlecheck.mjs
claude plugin validate . --strict
npm audit --audit-level=moderate
git diff --check origin/main...HEAD
```

Expected: every command exits 0, benchmark reports no violations and both
OpenSSH modes report `authPersistedAfterRestart: true`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .claude-plugin/plugin.json src/version.ts CHANGELOG.md bundle
git commit -m "release: prepare Claude Code plugin 1.4.1"
```

### Task 4: Publish and reinstall 1.4.1

**Files:**
- No source changes unless CI finds a reproducible defect.

- [ ] **Step 1: Push and create the PR**

```bash
git push -u origin codex/cross-platform-distribution
gh pr create --base main --head codex/cross-platform-distribution \
  --title "Document supported runtimes and prepare plugin 1.4.1" \
  --body "Claude Code prerequisites, lifecycle commands, support matrix and marketplace ownership; all release gates included."
```

- [ ] **Step 2: Require green CI and merge**

Run: `gh pr checks --watch --interval 5`

Expected: every required check passes.

Run: `gh pr merge --merge`

- [ ] **Step 3: Create the GitHub release**

After synchronizing `main`, run:

```bash
gh release create v1.4.1 --target main --title "Codex Orchestrator 1.4.1" \
  --notes-file CHANGELOG.md
```

Verify: `gh release view v1.4.1 --json tagName,url,isDraft,isPrerelease`

- [ ] **Step 4: Reinstall from the terminal**

```bash
claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes
claude plugin marketplace update codex-orchestrator
claude plugin install codex-orchestrator@codex-orchestrator --scope user
claude plugin list --json
claude mcp list
```

Expected: version 1.4.1 is enabled and the MCP is connected.

- [ ] **Step 5: Prepare the external Anthropic submission**

Open `https://claude.ai/settings/plugins/submit`, populate it from
`docs/distribution/anthropic-plugin-submission.md`, show the final values before
submission and submit only through the authenticated user's Anthropic account.
Record the acknowledgement URL or identifier in the document and change status
to `Submitted`. Do not change status to `Officially listed` without directory
evidence.
