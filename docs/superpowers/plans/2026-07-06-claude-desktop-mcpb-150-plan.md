# Claude Desktop MCPB 1.5.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a minimal, reproducible and one-click installable MCPB release for Claude Desktop that runs the existing local Codex Orchestrator without collecting credentials.

**Architecture:** Package the existing esbuild stdio bundle with a small project-directory launcher and manifest version 0.3. Add transport-neutral MCP prompts to preserve the guided workflow outside Claude Code while retaining one canonical tool implementation.

**Tech Stack:** TypeScript, MCP SDK 1.29.0, MCPB CLI 2.1.2, Node.js test runner, GitHub Releases.

**Precondition:** Release 1.4.1 is merged, tagged, installed and verified. Start this plan from that `origin/main` on a new `codex/claude-desktop-mcpb` worktree branch.

---

### Task 1: Add transport-neutral MCP prompts

**Files:**
- Modify: `src/server.ts`
- Create: `tests/prompts.test.mjs`

- [ ] **Step 1: Write the failing prompt inventory test**

Create `tests/prompts.test.mjs` using `Client` and `StdioClientTransport`, start
`bundle/server.mjs` with a temporary `ORCH_HOME` and fake Codex, and assert:

```js
const prompts = await client.listPrompts();
assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [
    "codex_orchestrator",
    "orchestrator_status",
]);
const rendered = await client.getPrompt({
    name: "codex_orchestrator",
    arguments: { request: "Add deterministic validation" },
});
assert.match(rendered.messages[0].content.text, /orchestrator_doctor/);
assert.match(rendered.messages[0].content.text, /Add deterministic validation/);
```

- [ ] **Step 2: Verify RED**

Run: `npm run bundle && node --test tests/prompts.test.mjs`

Expected: FAIL because the current server exposes no prompts.

- [ ] **Step 3: Register the two prompts**

Before the first tool registration in `src/server.ts`, add:

```ts
server.registerPrompt("codex_orchestrator", {
  title: "Codex Orchestrator",
  description: "Plan and supervise a Codex implementation through gated clusters.",
  argsSchema: { request: z.string().min(1).max(20_000) },
}, ({ request }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: `Run orchestrator_doctor first. Then decompose this request into gated clusters, form explicit hypotheses, delegate bounded slices to Codex, review every result and confirm only after declared checks pass. Request: ${request}`,
    },
  }],
}));

server.registerPrompt("orchestrator_status", {
  title: "Orchestrator Status",
  description: "Load the durable state of an orchestration plan.",
  argsSchema: { plan_id: z.string().optional() },
}, ({ plan_id }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: plan_id
        ? `Call plan_snapshot for plan ${plan_id}, then summarize cluster, task, review and check status without changing state.`
        : "Identify the current plan from available task events, call plan_snapshot and summarize status without changing state.",
    },
  }],
}));
```

- [ ] **Step 4: Verify GREEN**

Run: `npm run bundle && node --test tests/prompts.test.mjs tests/commands.test.mjs`

Expected: both prompts and both Claude Code components pass their inventories.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/prompts.test.mjs bundle/server.mjs
git commit -m "feat: expose transport-neutral orchestration prompts"
```

### Task 2: Create the MCPB source package

**Files:**
- Create: `packaging/mcpb/manifest.json`
- Create: `packaging/mcpb/server/launcher.mjs`
- Create: `packaging/mcpb/.mcpbignore`
- Create: `tests/mcpb.test.mjs`

- [ ] **Step 1: Write the failing manifest contract test**

Create `tests/mcpb.test.mjs` and assert:

```js
const manifest = JSON.parse(readFileSync("packaging/mcpb/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, "0.3");
assert.equal(manifest.name, "codex-orchestrator");
assert.equal(manifest.version, JSON.parse(readFileSync("package.json", "utf8")).version);
assert.equal(manifest.server.type, "node");
assert.equal(manifest.server.entry_point, "server/launcher.mjs");
assert.equal(manifest.user_config.project_directory.type, "directory");
assert.equal(manifest.user_config.project_directory.required, true);
assert.equal(JSON.stringify(manifest).match(/token|api_key|auth\.json/gi), null);
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/mcpb.test.mjs`

Expected: FAIL because `packaging/mcpb/manifest.json` does not exist.

- [ ] **Step 3: Create the MCPB manifest**

Create `packaging/mcpb/manifest.json`:

```json
{
  "manifest_version": "0.3",
  "name": "codex-orchestrator",
  "display_name": "Codex Orchestrator",
  "version": "1.5.0",
  "description": "Let Claude Desktop supervise local OpenAI Codex work through gated implementation slices.",
  "long_description": "Runs locally. Requires Git, an installed Codex CLI and an existing Codex login. Credentials are never requested or bundled.",
  "author": { "name": "Tom Werner", "url": "https://github.com/tomtastisch" },
  "repository": { "type": "git", "url": "https://github.com/tomtastisch/codex-orchestrator.git" },
  "homepage": "https://github.com/tomtastisch/codex-orchestrator",
  "documentation": "https://github.com/tomtastisch/codex-orchestrator#claude-desktop",
  "support": "https://github.com/tomtastisch/codex-orchestrator/issues",
  "server": {
    "type": "node",
    "entry_point": "server/launcher.mjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/launcher.mjs"],
      "env": {
        "ORCH_PROJECT_DIR": "${user_config.project_directory}",
        "ORCH_HOME": "${HOME}/.codex-orchestrator/desktop"
      }
    }
  },
  "tools_generated": true,
  "prompts_generated": true,
  "keywords": ["codex", "orchestration", "development", "mcp"],
  "license": "MIT",
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=22.5.0" }
  },
  "user_config": {
    "project_directory": {
      "type": "directory",
      "title": "Project directory",
      "description": "Git repository in which Codex Orchestrator may work.",
      "required": true,
      "default": "${HOME}/Documents"
    }
  }
}
```

- [ ] **Step 4: Create the fail-closed launcher**

Create `packaging/mcpb/server/launcher.mjs`:

```js
#!/usr/bin/env node
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const configured = process.env.ORCH_PROJECT_DIR;
if (!configured || !isAbsolute(configured)) throw new Error("ORCH_PROJECT_DIR must be an absolute path");
const project = resolve(configured);
if (!lstatSync(project).isDirectory()) throw new Error("ORCH_PROJECT_DIR must be a directory");
process.chdir(project);
await import(pathToFileURL(resolve(import.meta.dirname, "server.mjs")).href);
```

Test traversal normalization, missing directory and successful launch via a
temporary fixture before importing the real server.

- [ ] **Step 5: Add package exclusions**

Create `packaging/mcpb/.mcpbignore`:

```text
*.tmp
*.log
.env*
auth.json
state.sqlite*
```

- [ ] **Step 6: Verify GREEN**

Run: `npm run build && node --test tests/mcpb.test.mjs`

Expected: manifest and launcher contract tests pass.

- [ ] **Step 7: Commit**

```bash
git add packaging/mcpb tests/mcpb.test.mjs
git commit -m "feat: add Claude Desktop MCPB package"
```

### Task 3: Build and inspect the MCPB reproducibly

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/build-mcpb.mjs`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Install the pinned packager**

Run: `npm install --save-dev --save-exact @anthropic-ai/mcpb@2.1.2`

Add scripts:

```json
"mcpb:build": "node scripts/build-mcpb.mjs",
"mcpb:validate": "mcpb validate packaging/mcpb"
```

- [ ] **Step 2: Implement the argv-only build script**

`scripts/build-mcpb.mjs` must:

1. reject any package/manifest version mismatch;
2. remove and recreate `release/mcpb/staging`;
3. copy `manifest.json`, `.mcpbignore`, launcher, `LICENSE` and
   `bundle/server.mjs` to `staging/server/server.mjs`;
4. run `mcpb validate release/mcpb/staging` with `spawnSync`, `shell: false`;
5. run `mcpb pack release/mcpb/staging release/codex-orchestrator-<version>.mcpb`;
6. compute and write the artifact SHA-256;
7. print JSON containing version, artifact, bytes and checksum.

Use `copyFileSync`, `mkdirSync`, `rmSync`, `createHash` and `spawnSync`; reject
non-zero subprocess status and never read credential files.

- [ ] **Step 3: Ignore generated release output**

Append to `.gitignore`:

```text
release/
```

- [ ] **Step 4: Add CI gates**

After bundle verification in `.github/workflows/ci.yml`, add:

```yaml
      - run: npm run mcpb:validate
      - run: npm run mcpb:build
      - run: node scripts/verify-mcpb.mjs
```

`scripts/verify-mcpb.mjs` must unzip to a temporary directory, reject absolute
or traversal entries, assert the exact allowlist and start the extracted
launcher with Fake-Codex for MCP handshake, 17 tools, 2 prompts and healthy
Doctor.

- [ ] **Step 5: Run the package gates twice**

```bash
npm run bundle
npm run mcpb:build
cp release/codex-orchestrator-1.5.0.mcpb /tmp/first.mcpb
npm run mcpb:build
cmp /tmp/first.mcpb release/codex-orchestrator-1.5.0.mcpb
node scripts/verify-mcpb.mjs
```

Expected: byte-identical archives and a successful extracted MCP smoke test.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/build-mcpb.mjs scripts/verify-mcpb.mjs .gitignore .github/workflows/ci.yml
git commit -m "build: package reproducible MCPB releases"
```

### Task 4: Release, install and publish MCPB 1.5.0

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify all version sources and generated bundles.

- [ ] **Step 1: Set version 1.5.0 and update docs**

Synchronize package, lockfile, Claude plugin manifest, runtime and MCPB manifest.
Change Claude Desktop status to `Produktionsbereit` only after Step 4 succeeds.
Document prerequisites, GitHub Release download, Settings → Extensions →
Advanced settings → Install Extension, project-directory selection and Doctor.

- [ ] **Step 2: Execute all local release gates**

Run the 1.4.1 gates plus `npm run mcpb:validate`, `npm run mcpb:build` and
`node scripts/verify-mcpb.mjs`.

- [ ] **Step 3: Publish through PR and GitHub Release**

After green CI and merge, create release `v1.5.0` attaching:

```bash
gh release create v1.5.0 \
  release/codex-orchestrator-1.5.0.mcpb \
  release/codex-orchestrator-1.5.0.mcpb.sha256 \
  --title "Codex Orchestrator 1.5.0" --notes-file CHANGELOG.md
```

- [ ] **Step 4: Install the exact release artifact in Claude Desktop**

Download the release asset to a fresh temporary path, verify SHA-256, install it
through Claude Desktop, select a disposable Git repository, confirm 17 tools,
2 prompts and a healthy Doctor, then perform one supervised Codex change.

- [ ] **Step 5: Update production status and prepare directory submission**

Commit the factual installation evidence under
`docs/distribution/claude-desktop-verification.md`, set README status to
`Produktionsbereit`, publish a patch release if this evidence changes tracked
files, and prepare the Anthropic Desktop Extensions directory form. Do not mark
the extension listed until it appears in the directory.
