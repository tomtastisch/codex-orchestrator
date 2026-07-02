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
![Node >= 22.5](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)
![Status: stable](https://img.shields.io/badge/status-stable-green)

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

```
Claude (orchestrator)
  │  13 MCP tools
codex-orchestrator (this server)
  ├─ Session manager   — slice loop, resume, pause/cancel/inject, limits, reaper
  ├─ State store       — SQLite: plans, clusters, tasks, events, hypotheses,
  │                      reviews, retrospectives, checks (append-only audit)
  ├─ State machine     — planned → active → submitted → in_review → confirmed,
  │                      confirm gated on review + green checks
  ├─ Check runner      — allow-listed argv commands only, no free-form shell
  └─ Worktree manager  — git worktree isolation for parallel tasks, gated merge
  │
Codex CLI  →  codex exec / resume  (--json, isolated from user config,
              sandbox + model + reasoning effort set per task)
```

Each Codex assignment runs as a sequence of bounded slices. At every slice
boundary the server parses the structured result, persists events, and applies
queued control actions (pause, cancel, injected instructions). Small tasks run
as a single synchronous slice; long tasks run in the background while Claude
polls with a long-poll `task_wait`.

## Prerequisites

- Node.js ≥ 22.5 (uses the built-in `node:sqlite`)
- [Codex CLI](https://github.com/openai/codex) installed and logged in
  (`codex login status` → *Logged in*)
- git (for worktree isolation and merge)

## Installation

### As a Claude Code plugin (recommended)

```
/plugin marketplace add tomtastisch/codex-orchestrator
/plugin install codex-orchestrator
```

This registers the MCP server (pre-bundled, no build step) and the
`codex-orchestrator` skill, which teaches Claude the full orchestration
workflow.

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

## Tools

| Tool | Purpose |
|---|---|
| `task_start` | Start a Codex assignment (slice budget, sandbox, model, effort, worktree, wait mode) |
| `task_wait` | Long-poll for new events / slice boundaries — the core orchestration primitive |
| `task_events` | Cursor-based event history, filterable by kind |
| `task_control` | `pause` \| `resume` \| `cancel` \| `inject` (delivered at the next slice boundary) |
| `task_result` | Consolidated result: diff summary, tests, recent `SLICE_RESULT`s, open items |
| `models_list` | Available models, effort ladder, routing table, escalation rule |
| `cluster_plan` | Create/update a persistent plan with gated clusters (idempotent) |
| `cluster_transition` | `start`/`submit`/`review`/`confirm`/`retro`/… — server-enforced state machine |
| `cluster_merge` | Merge a reviewed worktree branch back (conflicts abort cleanly) |
| `hypotheses` | Record, confirm, reject, supersede assumptions with evidence |
| `repo_check` | Run allow-listed checks (tests, lint, typecheck, diff stats) |
| `plan_snapshot` | Durable TOON/JSON snapshot of the full plan state |
| `codex_update` | Check/apply Codex CLI updates (stable or pre-release channel) |

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

## Development

```bash
npm ci
npm run build        # TypeScript → dist/
npm test             # unit tests (parser, state machine, isolation) — no API calls
npm run bundle       # single-file bundle → bundle/server.mjs
node scripts/modelcheck.mjs    # model/effort validation (no API)
node scripts/bundlecheck.mjs   # MCP handshake against the bundle (no API)
node scripts/e2e-mcp.mjs       # end-to-end with a real Codex slice (uses your Codex account)
node scripts/e2e-m1m3.mjs      # worktree, pause/inject/resume, merge (uses your Codex account)
```

## License

[MIT](LICENSE) © 2026 Tom Werner
