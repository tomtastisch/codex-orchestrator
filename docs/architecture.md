# Architecture

Codex Orchestrator is a hexagonal (ports & adapters) system. Claude is the
orchestrator/reviewer, the Codex CLI is the implementation executor, and a
server-enforced state machine guarantees that nothing counts as done until
reviews and checks are green. This document describes the layers, the runtime
flow, and the boundaries that keep them honest.

- Ports & adapters detail: [`ports-and-adapters.md`](ports-and-adapters.md)
- Module/file inventory and test mapping: [`module-reference.md`](module-reference.md)
- Review/merge governance: [`review-policy.md`](review-policy.md)

## Layers

The core depends only on abstractions (ports). Infrastructure (SQLite, the
filesystem, process spawning, SSH, the MCP transport) sits behind those ports as
interchangeable adapters. The composition root (`src/server.ts` +
`src/app/context.ts`) is the only place that constructs concrete adapters and
wires them together.

```mermaid
flowchart TD
    subgraph app["Application — src/app/ (use-cases)"]
        Tools["tools/{diagnostics,tasks,planning,knowledge}.ts<br/>17 MCP tools + 2 prompts"]
        Ctx["context.ts — AppContext (composition root)"]
    end

    subgraph domain["Domain — pure business rules (no I/O)"]
        SM["statemachine.ts — cluster gate"]
        HY["hypotheses.ts — versioned hypotheses"]
        RS["resolve.ts / prompts.ts / gate.ts"]
    end

    subgraph ports["Ports — src/ports/ + execution/types.ts"]
        PS["PersistenceStore"]
        CK["Clock / IdGenerator"]
        ET["ExecutionTarget"]
    end

    subgraph adapters["Adapters (infrastructure)"]
        DB["db.ts — SQLite Store"]
        SC["system-clock.ts"]
        EX["execution/ — local + ssh targets"]
        WK["worker/ · runtime/ — process spawn, worker protocol"]
    end

    Tools --> domain
    Tools --> ports
    domain --> ports
    Ctx -->|injects| adapters
    DB -. implements .-> PS
    SC -. implements .-> CK
    EX -. implements .-> ET
```

**The dependency rule:** arrows point inward. Domain and application modules
import ports, never adapters. `tests/architecture-boundary.test.mjs` and
`tests/execution-boundary.test.mjs` enforce this statically on every push — a
consumer that reaches for `db.js`, `node:sqlite`, or a raw `store.db` gateway
fails the build. See [`ports-and-adapters.md`](ports-and-adapters.md).

## Runtime flow

Claude drives MCP tool calls; the server enforces the gates and persists all
state in SQLite so it survives context compaction and restarts.

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

Each Codex assignment runs as a sequence of bounded, resumable slices. At every
slice boundary the server parses the structured `SLICE_RESULT`, persists events,
and applies queued control actions (pause, cancel, injected instructions). Small
tasks run as a single synchronous slice; long tasks run in the background while
Claude polls with a long-poll `task_wait`.

## Cluster lifecycle

A cluster reaches `confirmed` only with a passing review **and** green
server-run checks. The happy path runs down the centre; the two exceptional
transitions to `blocked` are dotted.

```mermaid
flowchart TD
    P([planned]) -->|start: predecessors confirmed + retro done| A([active])
    A -->|submit| S([submitted])
    S -->|review: runs declared checks| R{in_review}
    R -->|"confirm — review confirmed AND checks green"| C([confirmed])
    C -->|retro mandatory, then next cluster| Done([done])
    R -->|request_changes| N([needs_changes])
    N -->|targeted fix, resume Codex| A
    A -.->|limit breach| B([blocked])
    R -.->|block| B
```

The invariant: **"Codex says done" never ends a cluster** — only a passing
review plus green server-run checks does. The server independently re-runs the
declared checks, so a self-reported "pass" that actually exited non-zero is
caught and the submission is refused.

## Security model (fail-closed)

- `danger-full-access` is disabled server-side and unreachable via any tool parameter.
- Codex runs with `--ignore-user-config`: isolated from global plugins, personality and trust settings; auth still comes from `CODEX_HOME`.
- Network access for slices is off by default, enabled per task only.
- `repo_check` executes allow-listed argv commands only — no free-form shell from either model.
- Per-task `extra_config` passes through a category blocklist (`sandbox*`, `mcp_servers*`, `hooks*`, `shell_environment_policy*`, `danger*`, …).
- Hard limits per task (max slices, max runtime, max diff size) → breach sets `blocked` and hands the decision to the orchestrator.
- The event log is append-only; every `confirm` references review and check IDs. The audit trail is secret-redacted (`audit_log`).

## Multi-project isolation

- One store per project (`ORCH_HOME`, default `<cwd>/.orchestrator`).
- Tasks are stamped with the owning process PID; the startup reaper only fails tasks of **dead** processes — a concurrently running instance of another project is never touched.
- A second instance on the same store logs a loud warning; SQLite runs in WAL mode with a busy timeout.
- Codex threads are isolated per task by design.

## Single source of truth

Runtime versions, coverage floors, the test schema and the architecture layer
manifest live once under `ssot/` (indexed by `ssot/index.toml`) and are bound to
every consumer by contract tests. Change a value in its owning JSON file only;
the contract test fails if any consumer drifts.
