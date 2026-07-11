# Architecture

Codex Orchestrator applies hexagonal architecture at its established dependency
boundaries. The established ports: persistence, clock/id, execution. Claude is
the orchestrator/reviewer, the Codex CLI is the implementation executor, and a
server-enforced state machine guarantees that nothing counts as done until
reviews and checks are green. This document describes the layers, runtime flow,
and currently enforced boundaries without treating every infrastructure concern
as an interchangeable port.

- Ports & adapters detail: [`ports-and-adapters.md`](ports-and-adapters.md)
- Module/file inventory and test mapping: [`module-reference.md`](module-reference.md)
- Review/merge governance: [`review-policy.md`](review-policy.md)

## Layers

`statemachine.ts` and `prompts.ts` are the infrastructure-independent core
services declared by the SSOT. `resolve.ts`, `session.ts`, and `checks.ts` are
application services: they coordinate ports with configuration, repository
validation, or execution policy. `HypothesisRepo` is the repository/DAO.
Snapshot and artifact writers are output adapters; worktree, runtime, and worker
modules are concrete infrastructure adapters. Filesystem, MCP transport,
review, updater, and other concerns are not claimed to be interchangeable ports
unless a code contract enforces that boundary.

```mermaid
flowchart TD
    subgraph composition["Composition roots"]
        Server["server.ts — process bootstrap"]
        Ctx["app/context.ts — application bootstrap"]
        ER["execution/registry.ts — execution feature composition root"]
    end

    subgraph application["Application services and MCP use cases"]
        Tools["tools/{diagnostics,tasks,planning,knowledge}.ts — 17 MCP tools"]
        Prompts["app/prompts.ts — 2 MCP prompts"]
        RS["resolve.ts — application service"]
        SS["session.ts · checks.ts — application services"]
        XR["execution/router.ts — execution application/router"]
    end

    subgraph core["Infrastructure-independent core services"]
        SM["statemachine.ts — cluster gate"]
        PR["prompts.ts"]
    end

    subgraph repos["Repository / DAO"]
        HY["hypotheses.ts — HypothesisRepo"]
    end

    subgraph contracts["Ports and execution contracts"]
        PS["PersistenceStore"]
        CK["Clock / IdGenerator"]
        ET["ExecutionTarget"]
        EE["execution/errors.ts — execution errors"]
    end

    subgraph adapters["Concrete output and infrastructure adapters"]
        DB["db.ts — SQLite Store"]
        SC["system-clock.ts"]
        EX["execution/local-target.ts · execution/ssh/*"]
        OUT["snapshot.ts · artifact.ts — output adapters"]
        INF["worktree.ts · runtime/* · worker/* — infrastructure adapters"]
    end

    Server --> Ctx
    Ctx --> ER
    Ctx -->|constructs + injects| DB
    Ctx -->|injects| SC
    ER --> EX
    Tools --> SM
    Tools --> PR
    Tools --> HY
    Tools --> RS
    Tools --> SS
    Tools --> XR
    Prompts --> PR
    core --> PS
    RS --> PS
    SS --> PS
    SS --> ET
    XR --> ET
    XR --> EE
    HY --> PS
    OUT --> PS
    DB -. implements .-> PS
    SC -. implements .-> CK
    EX -. implements .-> ET
```

For the established boundaries, dependency arrows point from consumers to
ports. `tests/architecture-boundary.test.mjs` enforces the declared persistence,
clock/id, core-consumer, application-service, and composition-root contracts;
`tests/execution-boundary.test.mjs` enforces the execution seam. A persistence
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
