# Module & Test Reference

Source lives under `src/`, grouped by architectural role. Tests live under
`tests/` and are named after the module or contract they cover, so each test is
directly assignable to what it protects.

## Source layout by layer

| Layer | Path | Responsibility |
|---|---|---|
| **Ports** | `src/ports/persistence.ts` | `PersistenceStore` port + row DTOs + `SCHEMA_VERSION` |
| | `src/ports/clock.ts` | `Clock` / `IdGenerator` ports |
| | `src/execution/types.ts` | `ExecutionTarget` port |
| **Infrastructure-independent core services** | `src/statemachine.ts` | Cluster gate / transition rules through the persistence port |
| | `src/resolve.ts`, `src/prompts.ts` | Model resolution and slice prompts through the persistence port |
| **Repository / DAO** | `src/hypotheses.ts` | `HypothesisRepo` repository/DAO for versioned, append-only hypotheses |
| **Domain rules** | `src/gate.ts` | Hypothesis gate |
| **Application** | `src/app/context.ts` | `AppContext` + application bootstrap composition (`createAppContext`) |
| | `src/app/prompts.ts` | The 2 MCP prompts |
| | `src/app/tools/{diagnostics,tasks,planning,knowledge}.ts` | The 17 MCP tools, grouped by use-case |
| **Adapters** | `src/db.ts`, `src/db/migrations.ts` | SQLite `Store` (implements `PersistenceStore`) |
| | `src/system-clock.ts` | System `Clock` / `IdGenerator` |
| | `src/execution/local-target.ts`, `src/execution/ssh/*`, `src/execution/{router,errors}.ts` | Execution target adapters + routing |
| | `src/session.ts` | Session manager: slice loop, resume, inject, limits, reaper |
| | `src/checks.ts`, `src/worktree.ts`, `src/snapshot.ts`, `src/artifact.ts` | Check runner, worktree isolation/merge, snapshots, artifacts |
| | `src/runtime/*`, `src/worker/*` | Process spawn, environment, worker protocol |
| **Application bootstrap composition roots** | `src/server.ts`, `src/app/context.ts` | Process entry point and application graph wiring |
| **Execution feature composition root** | `src/execution/registry.ts` | Constructs the configured execution targets and router |
| **Cross-cutting** | `src/config*.ts`, `src/redact.ts`, `src/sandbox.ts`, `src/codex.ts`, `src/updater.ts`, `src/doctor.ts`, `src/auth/bootstrap.ts`, `src/version.ts`, `src/types.ts` | Config, redaction, sandbox policy, Codex/update/doctor, auth bootstrap |

## Tests by concern

| Concern | Test files |
|---|---|
| **Architecture boundaries** | `architecture-boundary`, `execution-boundary` |
| **Persistence & migrations** | `persistence`, `migrations`, `clock-injection` |
| **Domain: state machine / gate** | `statemachine`, `cluster-gate`, `gate` |
| **Repository / DAO: hypotheses** | `hypotheses`, `hypothesis-update` |
| **Application / tools** | `commands`, `resolve`, `prompts`, `agents`, `config-agents` |
| **Execution (local + SSH)** | `execution-registry`, `router`, `local-target`, `ssh-client`, `ssh-protocol`, `ssh-target`, `worker`, `worker-deploy`, `remote-acceptance` |
| **Isolation & security** | `isolation`, `security`, `security-boundaries`, `project-boundary`, `redundancy`, `integrity` |
| **Checks / artifacts / snapshots / events** | `checks`, `artifact`, `events`, `doctor`, `updater` |
| **Governance & SSOT contracts** | `quality-policy`, `coverage-runner`, `ssot`, `review-policy`, `readme-contract`, `release-policy`, `baseline`, `mcpb`, `benchmark` |

Run everything with `npm test` (recursive over `tests/**/*.test.mjs`) or
`npm run test:coverage` to enforce the coverage floors. Test discovery,
directory and suffix are defined once in `ssot/tests.json`.
