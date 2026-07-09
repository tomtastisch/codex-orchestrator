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
| **Domain** | `src/statemachine.ts` | Cluster gate / transition rules (pure) |
| | `src/hypotheses.ts` | Versioned, append-only hypotheses (`HypothesisRepo`) |
| | `src/resolve.ts`, `src/prompts.ts`, `src/gate.ts` | Model resolution, slice prompts, hypothesis gate |
| **Application** | `src/app/context.ts` | `AppContext` + composition (`createAppContext`) |
| | `src/app/prompts.ts` | The 2 MCP prompts |
| | `src/app/tools/{diagnostics,tasks,planning,knowledge}.ts` | The 17 MCP tools, grouped by use-case |
| **Adapters** | `src/db.ts`, `src/db/migrations.ts` | SQLite `Store` (implements `PersistenceStore`) |
| | `src/system-clock.ts` | System `Clock` / `IdGenerator` |
| | `src/execution/local-target.ts`, `src/execution/ssh/*`, `src/execution/{router,registry,errors}.ts` | Execution targets + routing + wiring |
| | `src/session.ts` | Session manager: slice loop, resume, inject, limits, reaper |
| | `src/checks.ts`, `src/worktree.ts`, `src/snapshot.ts`, `src/artifact.ts` | Check runner, worktree isolation/merge, snapshots, artifacts |
| | `src/runtime/*`, `src/worker/*` | Process spawn, environment, worker protocol |
| **Composition root** | `src/server.ts` | Thin entry point: wires everything, no business logic |
| **Cross-cutting** | `src/config*.ts`, `src/redact.ts`, `src/sandbox.ts`, `src/codex.ts`, `src/updater.ts`, `src/doctor.ts`, `src/auth/bootstrap.ts`, `src/version.ts`, `src/types.ts` | Config, redaction, sandbox policy, Codex/update/doctor, auth bootstrap |

## Tests by concern

| Concern | Test files |
|---|---|
| **Architecture boundaries** | `architecture-boundary`, `execution-boundary` |
| **Persistence & migrations** | `persistence`, `migrations`, `clock-injection` |
| **Domain: state machine / gate** | `statemachine`, `cluster-gate`, `gate` |
| **Domain: hypotheses** | `hypotheses`, `hypothesis-update` |
| **Application / tools** | `commands`, `resolve`, `prompts`, `agents`, `config-agents` |
| **Execution (local + SSH)** | `execution-registry`, `router`, `local-target`, `ssh-client`, `ssh-protocol`, `ssh-target`, `worker`, `worker-deploy`, `remote-acceptance` |
| **Isolation & security** | `isolation`, `security`, `security-boundaries`, `project-boundary`, `redundancy`, `integrity` |
| **Checks / artifacts / snapshots / events** | `checks`, `artifact`, `events`, `doctor`, `updater` |
| **Governance & SSOT contracts** | `quality-policy`, `coverage-runner`, `ssot`, `review-policy`, `readme-contract`, `release-policy`, `baseline`, `mcpb`, `benchmark` |

Run everything with `npm test` (recursive over `tests/**/*.test.mjs`) or
`npm run test:coverage` to enforce the coverage floors. Test discovery,
directory and suffix are defined once in `ssot/tests.json`.
