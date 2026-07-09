# Codex Orchestrator

**Let Claude orchestrate OpenAI Codex as a supervised implementation executor.**

An [MCP](https://modelcontextprotocol.io) server that couples Claude (architect,
orchestrator, reviewer) with the [Codex CLI](https://github.com/openai/codex)
(executor) through a *checkpoint-slice* execution model: Codex works in bounded,
resumable slices; Claude reviews every checkpoint; a server-enforced state
machine guarantees that nothing counts as done until reviews and checks are
green. All process state is persisted in SQLite — it survives context
compaction, session switches and server restarts.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 22.13–22.x or 24.x](https://img.shields.io/badge/node-22.13%E2%80%9322.x%20%7C%2024.x-brightgreen)
![Status: stable](https://img.shields.io/badge/status-stable-green)

Current version: 1.5.2

## Platform support

| Runtime | Status | Distribution |
|---|---|---|
| Claude Code CLI | Production ready | First-party GitHub marketplace |
| Claude Desktop MCPB | Released; technical verification passed | Latest GitHub release, version 1.5.2 |
| claude.ai Remote MCP | In development | Planned for release 1.6.0 |

The repository ships a production-ready Claude Code plugin and the released
Claude Desktop MCPB. Claude Desktop is not a prerequisite for the Claude Code
plugin. The Desktop artifact, checksum, startup, MCP handshake,
17 tools, two prompts and Doctor preflight have passed technical verification.
The remaining conversation-level slash-prompt run is an operator acceptance
check, not an unreleased implementation item. claude.ai cannot start this local
stdio server; its separate HTTP/OAuth connector therefore remains in
development for 1.6.0.

The externally installed server runtime is continuously verified with
Node.js 22.13–22.x and Node.js 24.x on Ubuntu, macOS and Windows. Claude Desktop's
built-in Node.js runtime is independent of this external-runtime matrix. The
22.13 minimum is required because the built-in `node:sqlite` module is available
without the `--experimental-sqlite` start flag only from Node.js 22.13 onward.
Every runtime version and coverage floor is defined once under `ssot/` (indexed by
`ssot/index.toml`) and bound to each consumer by contract tests. The portable matrix
exercises both LTS lines at their floor and current patch; development and the quality
gate run on Node 24 (`.nvmrc`), while release artifacts are built on the 22.13 floor so
a published bundle runs on the oldest supported runtime.
The canonical quality gate enforces these production-code coverage floors:
75 % lines, 70 % branches and 75 % functions. CodeQL scans both
JavaScript/TypeScript and GitHub Actions workflow code.

---

## Why

Letting one model both implement and judge its own work does not scale. This
server splits the roles:

- **Claude** plans, decomposes into clusters with acceptance criteria, picks
  model + reasoning effort per task, reviews results, maintains hypotheses,
  and confirms completion.
- **Codex** implements in sandboxed slices and reports in a structured
  `SLICE_RESULT` format — checkpoint, submission, or blocker (never
  improvising around missing information).
- **The server** enforces the process: `confirm` fails without a review and
  green checks, retrospectives are mandatory between clusters, limits and
  sandbox rules are fail-closed and unreachable from tool parameters.

A welcome side effect: implementation noise (file contents, diffs, test logs)
stays out of Claude's context window — typically **85–95 % fewer
Claude-side tokens** per delegated implementation task, with state kept in
SQLite and compact [TOON](https://github.com/toon-format/toon) snapshots
instead of chat history.

## How it works

```mermaid
flowchart TD
    User(["User"]) --> Claude["Claude<br/>orchestrator + reviewer"]
    Claude -->|"MCP tools"| SM

    subgraph SRV["codex-orchestrator MCP server"]
        direction TB
        SM["Session manager<br/>slice loop, resume, inject, limits, reaper"]
        FSM["State machine<br/>confirm gated on review + green checks"]
        Checks["Check runner<br/>allow-listed commands only"]
        WT["Worktree manager<br/>isolation + gated merge"]
        Store[("SQLite store<br/>plans, clusters, tasks, events,<br/>hypotheses, reviews, checks")]
    end

    SM -->|"codex exec / resume (--json)"| Codex["Codex CLI<br/>sandbox, model, effort per task"]
    Codex -->|"SLICE_RESULT"| SM
    Checks -->|"exit codes"| FSM
    WT --> Git[("git worktrees")]
    Codex --> Git
    SM --> Store
    FSM --> Store
    Checks --> Store
```

The cluster lifecycle is enforced by the server — a cluster reaches `confirmed`
only with a passing review **and** green server-run checks:

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> active: start (predecessors confirmed + retro done)
    active --> submitted: submit
    submitted --> in_review: review (runs declared checks)
    in_review --> needs_changes: request_changes
    needs_changes --> active: targeted fix, resume Codex
    in_review --> confirmed: confirm — only if review confirmed AND checks green
    in_review --> blocked: block
    active --> blocked: limit breach
    confirmed --> [*]: retro (mandatory), then next cluster
```

Each Codex assignment runs as a sequence of bounded slices. At every slice
boundary the server parses the structured result, persists events, and applies
queued control actions (pause, cancel, injected instructions). Small tasks run
as a single synchronous slice; long tasks run in the background while Claude
polls with a long-poll `task_wait`.

## Prerequisites

Run the common checks on the machine that executes Codex:

```bash
git --version
codex --version
codex login status  # must report Logged in
```

Required software and state:

- Git for repository and worktree operations.
- [Codex CLI](https://github.com/openai/codex), authenticated through
  `codex login`. The orchestrator uses this existing Codex session; it does not
  replace Codex authentication.
- One supported Claude runtime:
  - [Claude Code CLI](https://code.claude.com/docs/en/overview), installed
    locally and authenticated. `claude --version` must succeed before installing
    the Claude Code plugin. Its local plugin server requires Node.js 22.13–22.x
    or Node.js 24.x; verify it with `node --version`.
  - [Claude Desktop](https://claude.com/download), installed locally and
    authenticated before installing the MCPB. Desktop runs the MCPB with its
    built-in Node.js runtime; a separate project installation path and a
    separate local Node.js installation are not requested by the extension.
- Write access to the selected project. Claude Code additionally needs write
  access to the user-specific plugin cache.

Never paste `auth.json`, OAuth tokens or API keys into Claude or into an
installation command. See [Remote Codex execution and persistent
authentication](#remote-codex-execution-and-persistent-authentication) before
configuring a second host.

## Installation

### As a Claude Code plugin (recommended, production ready)

The plugin is available immediately from the project's First-party GitHub
marketplace. This canonical repository is the current installation source.

#### 1. Install from a terminal

```bash
claude plugin marketplace add tomtastisch/codex-orchestrator
claude plugin install codex-orchestrator@codex-orchestrator --scope user
```

No repository clone or local build is required. The marketplace installs the
pre-bundled MCP server into Claude's user plugin cache.

#### 2. Verify the installation

```bash
claude plugin list --json
claude mcp list
```

Require `codex-orchestrator@codex-orchestrator` to be enabled at the documented
version and `plugin:codex-orchestrator:codex-orchestrator` to report
`Connected`. If Claude Code was already running, restart it or run
`/reload-plugins` before checking the commands.

This registers the MCP server (pre-bundled, no build step) and the
`codex-orchestrator` skill, which teaches Claude the full orchestration
workflow. Start Claude in a project and invoke it with:

```text
/codex-orchestrator:codex-orchestrator Implement the requested change
```

Claude plugin skills are namespaced by design. The command therefore contains
the plugin name and the skill name. The companion status command is
`/codex-orchestrator:orchestrator-status [plan_id]`.

#### 3. Update

```bash
claude plugin marketplace update codex-orchestrator
```

Restart Claude Code or run `/reload-plugins`, then repeat the two verification
commands. The MCP server never mutates its own installed bundle.

#### 4. Uninstall

```bash
claude plugin uninstall codex-orchestrator@codex-orchestrator --scope user --yes
```

Project state remains in the project's `.orchestrator` directory unless the
operator removes it separately.

### Distribution and discovery status

The channels have different owners and must not be conflated:

| Channel | Owner | Current state |
|---|---|---|
| First-party GitHub marketplace | Codex Orchestrator project | Available now with the terminal commands above |
| `claude-community` | Anthropic, reviewed third-party directory | Submitted; Anthropic review pending; not yet listed |
| `claude-plugins-official` | Anthropic, separately curated | No application process; inclusion is solely at Anthropic's discretion |
| [Build with Claude](https://buildwithclaude.com) | Independent community directory | [PR #222 pending maintainer review](https://github.com/davepoon/buildwithclaude/pull/222); not an official Anthropic channel |
| [Cross AI Tools](https://crossaitools.com) | Independent community directory | Crawler-eligible; listing depends on external quality and editorial review; not an official Anthropic channel |

Anthropic's current process sends third-party plugins to `claude-community`
through the [Console submission form](https://platform.claude.com/plugins/submit).
After approval, users add `anthropics/claude-plugins-community` and install the
plugin as `codex-orchestrator@claude-community`. Approval and catalog sync are
external states; this README does not claim either before the public catalog
contains the plugin. The separate `claude-plugins-official` catalog has no
application process.

Build with Claude and Cross AI Tools are independent community directories,
not installation authorities. The Build with Claude metadata contribution is
currently awaiting maintainer review in
[PR #222](https://github.com/davepoon/buildwithclaude/pull/222). Cross AI Tools
has no direct submission form; its crawler discovers valid GitHub marketplace
schemas, then applies independent adoption, quality and editorial criteria.
The first-party commands in this README remain valid independently of those
external listings.

### Claude Desktop MCPB (released in 1.5.2)

Claude Desktop does not install Claude Code plugins. Release 1.5.2 provides a
dedicated MCP Bundle (`.mcpb`, formerly `.dxt`) for local installation. It uses
stdio and runs only on the local machine. It does not request, copy or bundle
`auth.json`, OAuth tokens or API keys; the child Codex CLI uses the existing
local `codex login` session.

The extension does not request an installation or project path. One global
installation can orchestrate multiple repositories.

#### 1. Download and verify the release artifact

Open the [latest release](https://github.com/tomtastisch/codex-orchestrator/releases/latest)
and download both `codex-orchestrator-1.5.2.mcpb` and
`codex-orchestrator-1.5.2.mcpb.sha256` into the same directory. On macOS or
Linux, verify the download before opening it:

```bash
shasum -a 256 -c codex-orchestrator-1.5.2.mcpb.sha256
```

#### 2. Install in Claude Desktop

In Claude Desktop, open
`Settings → Extensions → Advanced settings → Install Extension`, select the
verified `.mcpb` file and review the displayed permissions. No installation or
project path is requested. Complete the installation and fully restart Claude
Desktop if the connector does not appear immediately.

Anthropic also supports double-clicking the `.mcpb` file or dragging it into
Claude Desktop; the Extensions settings show the configuration and connection
state most clearly. Team and Enterprise policies may disable custom extension
installation.

#### 3. Verify tools and slash prompts

In a new Claude Desktop conversation:

1. Open `Add files, connectors, and more → Connectors` and require Codex
   Orchestrator to be connected.
2. Open the slash-command/prompt picker and select `codex_orchestrator`, then
   enter a bounded request and, when offered, the exact absolute Git repository
   root as `repo_path`. If `repo_path` is omitted, the prompt requires Claude to
   ask for it before creating a plan; Claude must never infer it.
   The repository path is selected per orchestration request, not during
   extension installation. A home directory, repository subdirectory, parent
   directory, non-Git directory or relative path is rejected. One installation
   may be used with different exact Git roots in separate requests.
3. Select `orchestrator_status` to inspect an existing plan. These are MCP
   prompts; Claude Desktop controls their final visual prefix and menu
   presentation.
4. Ask Claude to call `orchestrator_doctor`. Require `ok: true`, version `1.5.2`,
   `project_mode: "per-request-git-root"` and an authenticated local execution
   target before starting work.

The published bundle has already passed archive verification, startup,
`initialize`, `tools/list`, `prompts/list` and Doctor checks. Steps 1–4 above
are the final manual operator acceptance for the installed Desktop UI and one
real conversation, not deferred development work.

Callers may choose `worktree: "none"` to work directly in the validated
repository or `worktree: "auto"` for a server-managed isolated worktree.
Arbitrary caller-supplied worktree paths are rejected.

If connection startup fails on macOS, inspect `~/Library/Logs/Claude` and the
extension state in Settings. Never solve a login error by pasting credentials
into Claude; run `codex login` in a local terminal and retry Doctor.

The official installation flow is documented by
[Anthropic](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop),
and the bundle format is maintained in the
[MCPB specification repository](https://github.com/modelcontextprotocol/mcpb).

### claude.ai Remote MCP (in development)

claude.ai cannot run this repository's local stdio plugin. Release 1.6.0 will
provide a self-hosted, OAuth-protected Streamable HTTP connector for an
operator-controlled host. Do not expose the current stdio process through a
public tunnel and do not upload local Codex credentials to claude.ai.

### As a plain MCP server

```bash
git clone https://github.com/tomtastisch/codex-orchestrator.git
cd codex-orchestrator && npm ci && npm run build
claude mcp add codex-orchestrator -- node "$PWD/dist/server.js"
```

### Per-project registration (multi-project isolation)

Register the server per project with its own store to keep concurrent
projects fully separated:

```json
{
  "mcpServers": {
    "codex-orchestrator": {
      "command": "node",
      "args": ["/path/to/codex-orchestrator/bundle/server.mjs"],
      "env": { "ORCH_HOME": "${workspaceFolder}/.orchestrator" }
    }
  }
}
```

Without `ORCH_HOME` the store defaults to `<cwd>/.orchestrator`, so separate
project directories are isolated automatically.

## Remote Codex execution and persistent authentication

Create `.orchestrator/config.json` in the project from which Claude is started:

```json
{
  "version": 1,
  "execution": {
    "mode": "remote-preferred",
    "fallback": "connectivity-only",
    "remote": {
      "id": "devbox",
      "transport": "ssh",
      "host": "devbox",
      "repository": {
        "localRoot": "/Users/me/projects",
        "remoteRoot": "/home/me/projects"
      },
      "codexBin": "codex",
      "workerRoot": "~/.cache/codex-orchestrator",
      "codexHome": "~/.codex",
      "auth": {
        "strategy": "sync-file",
        "source": "/Users/me/.codex/auth.json"
      }
    }
  }
}
```

The source must be an owner-controlled regular file with no group or world
permissions (`chmod 600 ~/.codex/auth.json`). The credential is transferred in
the validated worker protocol, written atomically to the persistent remote
`codexHome` with mode `0600`, and never included in task events or tool results.
Every slash-command preflight and task resolves `~/` against the remote user's
home, starts Codex with that exact `CODEX_HOME` and performs a fresh
`codex login status` check. If the remote file
is missing or stale, `sync-file` installs or refreshes it and then repeats the
check. This survives Claude, plugin and target restarts as long as the remote
home directory persists.

For managed environments, use a secret manager command instead of a file:

```json
"auth": {
  "strategy": "access-token",
  "secretCommand": ["security", "find-generic-password", "-s", "codex-access-token", "-w"]
}
```

The command output is passed only through stdin to `codex login
--with-access-token`; it is not stored by the orchestrator. `existing` is the
strictest strategy and fails if the remote Codex installation is not already
authenticated. Local fallback is permitted only for retryable connectivity
errors, never for authentication, host-key, protocol or repository mismatches.

## MCP prompts and tools

### Prompts

| Prompt | Purpose |
|---|---|
| `codex_orchestrator` | Start a guided, gated orchestration request; accept or request the exact Git repository root per invocation |
| `orchestrator_status` | Load and summarize durable plan, task, review and check state without mutation |

### Tools

| Tool | Purpose |
|---|---|
| `task_start` | Start a Codex assignment linked to a mandatory hypothesis (slice budget, sandbox, model, effort, worktree, wait mode) |
| `orchestrator_doctor` | Verify configured targets, Codex versions and authentication; securely bootstrap remote auth |
| `task_wait` | Long-poll for new events / slice boundaries — the core orchestration primitive |
| `task_events` | Cursor-based event history, filterable by kind |
| `task_control` | `pause` \| `resume` \| `cancel` \| `inject` (delivered at the next slice boundary) |
| `task_result` | Consolidated result: diff summary, tests, recent `SLICE_RESULT`s, open items |
| `models_list` | Available models, effort ladder, routing table, escalation rule |
| `cluster_plan` | Create/update a persistent plan with gated clusters (idempotent) |
| `cluster_transition` | `start`/`submit`/`review`/`confirm`/`retro`/… — server-enforced state machine |
| `cluster_merge` | Merge a reviewed worktree branch back (conflicts abort cleanly) |
| `hypotheses` | Create and append-only update versioned, falsifiable assumptions with evidence |
| `user_decision` | Persist user decisions and standing preferences for review findings |
| `repo_check` | Run allow-listed checks (tests, lint, typecheck, diff stats) |
| `plan_snapshot` | Durable TOON/JSON snapshot of the full plan state |
| `result_artifact` | Generate a checksummed final `.toln` run artifact and summary |
| `audit_log` | Read the secret-redacted security audit trail |
| `codex_update` | Check/apply Codex CLI updates (stable or pre-release channel) |

## Example: from a goal to a confirmed change

A minimal end-to-end walkthrough of what the orchestrator actually does. Claude
drives these tool calls; the server enforces the gates.

**1. Goal → plan.** Claude turns a request ("add input validation to the signup
endpoint and cover it with tests") into a persistent, gated plan:

```jsonc
cluster_plan({
  goal: "Validate signup input and test it",
  repo_path: "/path/to/app",
  clusters: [{
    id: "C1", name: "signup-validation", goal: "Reject invalid signups + tests",
    acceptance: ["invalid email/'' password rejected with 400", "new unit tests pass"],
    model_policy: { model: "gpt-5.5", effort: "high", sandbox: "workspace-write" },
    review_strategy: { checks: ["npm_test", "typecheck"] }
  }]
})
// → { plan_id: "P_…", clusters: [{ id: "C1", status: "planned" }] }
```

**2. Start the gate, delegate to Codex.**

```jsonc
cluster_transition({ cluster_id: "C1", action: "start" })   // → status: "active"
hypotheses({
  action: "create", plan_id: "P_…", cluster_id: "C1",
  initial_assumption: "Input validation can be added without changing valid requests",
  confidence_before: 0.8,
  critical_questions: ["Which clients rely on current coercion?"],
  falsification_plan: ["Run existing compatibility tests"]
})
// → { hypothesis: { id: "H_…" } }
task_start({
  cluster_id: "C1", hypothesis_id: "H_…",
  sandbox: "workspace-write", model: "gpt-5.5", effort: "high",
  slice_budget: { max_minutes: 10 }, wait_for: "started", worktree: "auto",
  instructions: "Add validation to the signup handler; add unit tests. Report a SLICE_RESULT.",
  acceptance_criteria: ["invalid signups rejected with 400", "new tests pass"]
})
// → { task_id: "T_…", status: "running", worktree: "…/worktrees/T_…" }
```

**3. Supervise the slices.** Claude long-polls and reacts:

```jsonc
task_wait({ task_id: "T_…", cursor: 0 })
// checkpoint → optionally task_control({ action: "inject", message: "also trim whitespace" })
// submission → the SLICE_RESULT reports: tests "npm test: pass"
```

**4. Review — and the gate that makes it trustworthy.** The server independently
re-runs the declared checks; a self-reported "pass" that actually exited non-zero
is caught and the submission is refused.

```jsonc
cluster_transition({ cluster_id: "C1", action: "submit" })
cluster_transition({ cluster_id: "C1", action: "review", payload: { status: "confirmed" } })
// runs npm_test + typecheck server-side

cluster_transition({ cluster_id: "C1", action: "confirm" })
// ✗ if a check is red   → { ok: false, error: "confirm verweigert", reasons: ["Check 'npm_test' exit=1"] }
// ✓ if all green        → { ok: true, status: "confirmed" }
```

If review found problems instead: `request_changes` → a targeted correction task
resumes the same Codex session, then back to review.

**5. Confirm → retro → durable snapshot.**

```jsonc
cluster_transition({ cluster_id: "C1", action: "retro", payload: { content: "…lessons…" } })
cluster_merge({ cluster_id: "C1", task_id: "T_…" })       // merge the reviewed worktree
plan_snapshot({ plan_id: "P_…", format: "toon" })          // compact, compaction-proof state
```

The point: **"Codex says done" never ends a cluster** — only a passing review plus
green server-run checks does. Everything above is persisted, so the workflow
survives context compaction and server restarts.

## Per-task model & effort control

Every task specifies **which model** does the work and **how hard it thinks**:

```jsonc
{
  "model": "gpt-5.5",          // or "auto", validated against models_list
  "effort": "xhigh",            // low | medium | high | xhigh
  "sandbox": "read-only",       // or workspace-write
  "slice_budget": { "max_minutes": 8 }
}
```

Invalid combinations are rejected before Codex is ever started. The escalation
rule (two failed correction slices → next effort step or stronger model) is
part of the skill and the `models_list` output.

## Security model (fail-closed)

- `danger-full-access` is disabled server-side and not reachable via any tool
  parameter.
- Codex runs with `--ignore-user-config`: isolated from global plugins,
  personality and trust settings; auth still comes from `CODEX_HOME`.
- Network access for slices is **off by default**, enabled per task only.
- `repo_check` executes allow-listed argv commands only — no free-form shell
  from either model.
- Per-task `extra_config` passes through a category blocklist (`sandbox*`,
  `mcp_servers*`, `hooks*`, `shell_environment_policy*`, `danger*`, …) so it
  cannot be used for process or environment injection.
- Hard limits per task (max slices, max runtime, max diff size) → breach sets
  `blocked` and hands the decision to the orchestrator.
- The event log is append-only; every confirm references review and check IDs.

## Multi-project isolation

- One store per project (`ORCH_HOME`, default `<cwd>/.orchestrator`).
- Tasks are stamped with the owning process PID; the startup reaper only fails
  tasks of **dead** processes — a concurrently running instance of another
  project is never touched.
- A second instance on the same store logs a loud warning; SQLite runs in WAL
  mode with a busy timeout.
- Codex threads are isolated per task by design.

## Staying up to date

- The plugin itself follows Claude's marketplace lifecycle:
  `claude plugin marketplace update codex-orchestrator`, followed by a Claude
  restart or `/reload-plugins`. The MCP server never mutates its own installed
  bundle.
- The Codex CLI is updated only after an explicit `codex_update` call. The tool
  supports `check` and `apply` for `latest`, `alpha` and `beta`, and refuses to
  apply while tasks are active.

### Release policy

GitHub exposes exactly one current stable GitHub release and one corresponding
version tag. The latest supported artifact is always available through
[releases/latest](https://github.com/tomtastisch/codex-orchestrator/releases/latest).
Historical changes remain auditable in `CHANGELOG.md` and Git history instead
of being presented as parallel installable versions.

Every pull request's `quality` job publishes its verified MCPB, SHA-256 checksum
and `coverage/summary.txt` as one commit-addressed GitHub Actions artifact with
a seven-day retention period. These review artifacts are not releases and do
not change the one-stable-release invariant.

After a version change reaches `main`, the release workflow waits for the
portable, quality and remote-acceptance jobs, rebuilds and verifies the release artifacts,
publishes the new version, removes superseded releases and semantic-version
tags, marks the new release as latest, and checks the one-release/one-tag
invariant.

Relevant environment variables: `ORCH_HOME`, `ORCH_CONFIG_FILE`,
`ORCH_GLOBAL`, `ORCH_MAX_CONCURRENT`, `ORCH_SIGN_MERGE`, `ORCH_CODEX_BIN`,
`ORCH_REQUIRE_HYPOTHESIS`, `ORCH_MODEL_FAST`, `ORCH_MODEL_BALANCED` and
`ORCH_MODEL_STRONG`. Security-relevant defaults remain server-controlled;
unknown file configuration fields fail validation.

## Development

```bash
npm ci
npm run build        # TypeScript → dist/
npm test             # unit tests (parser, state machine, isolation) — no API calls
npm run test:coverage # production-only coverage; enforce 75/70/75 floors
npm run bundle       # single-file bundle → bundle/server.mjs
npm run verify:bundle # reproducibly rebuild and compare both release bundles
npm run benchmark    # 7 MCP starts; enforce size and p95 latency budgets
npm run test:remote  # real loopback OpenSSH, synthetic auth and fake Codex slice
npm run test:remote:real # real local Codex auth; no model turn
node scripts/modelcheck.mjs    # model/effort validation (no API)
node scripts/bundlecheck.mjs   # MCP handshake against the bundle (no API)
node scripts/e2e-mcp.mjs       # end-to-end with a real Codex slice (uses your Codex account)
node scripts/e2e-m1m3.mjs      # worktree, pause/inject/resume, merge (uses your Codex account)
```

The portable CI matrix runs the type, unit and reproducible-bundle checks on
Ubuntu, macOS and Windows with both supported Node.js LTS lines. The unit suite
includes protocol and fake-SSH coverage. `npm run test:remote` adds a real
OpenSSH transport: it creates ephemeral host and user keys, deploys
the actual worker bundle, bootstraps a synthetic credential, executes one fake
Codex slice, creates a fresh target instance and confirms that authentication
still works after the local source credential has been removed. CI runs this
acceptance test on macOS.

`npm run test:remote:real` repeats the persistence check with the current local
Codex binary and private `auth.json`. It does not execute a model turn. Both
remote tests use only temporary directories, terminate their owned `sshd`
process and remove all temporary keys and credentials before exit.

The release benchmark fails when either bundle exceeds its size budget or when
the p95 MCP cold-start/Doctor latency exceeds its budget. Current limits are
1.25 MiB for `bundle/server.mjs`, 256 KiB for `bundle/worker.mjs`, 2,500 ms for
cold start and 1,500 ms for Doctor. Override only the sample count with
`ORCH_BENCHMARK_ITERATIONS=5..50`; release budgets are intentionally fixed.

## License

[MIT](LICENSE) © 2026 Tom Werner
