# Checks dependency-injection report

## Scope and evidence

GitHub issue #32 requires application orchestration to depend on ports rather
than concrete adapters. The architecture SSOT classifies `src/checks.ts` as an
application service and `src/execution/types.ts` as the established
`ExecutionTarget` port. Inspection confirmed that `runChecks()` and
`diffSize()` imported `LocalExecutionTarget` and constructed it as an optional
parameter default.

Every production call site already passes an `ExecutionTarget` selected from
the composed execution runtime:

- `src/app/tools/planning.ts` passes `executionTargetForCluster(...)`;
- `src/app/tools/knowledge.ts` passes its selected target to both helpers;
- `src/app/tools/tasks.ts` passes the task target to `diffSize()`.

The concrete fallback was therefore an unnecessary application-to-adapter
dependency, not an active runtime-selection path.

## Test-driven correction

The architecture SSOT now enumerates the established execution-port consumers:
`src/session.ts`, `src/checks.ts`, and `src/execution/router.ts`.
`tests/execution-boundary.test.mjs` verifies that each declared consumer imports
the port and does not import either the local or SSH target adapter.

RED command:

```text
node --test tests/execution-boundary.test.mjs
```

RED result:

```text
tests: 5
pass: 4
fail: 1
failure: src/checks.ts must receive ExecutionTarget from composition
offending import: ./execution/local-target.js
```

The minimal production change removed the concrete import and made the
`ExecutionTarget` argument required in both exported helpers. No call site,
tool schema, tool name, response shape, persistence schema, version, security
policy, or target-selection rule changed.

Targeted GREEN command:

```text
node --test tests/execution-boundary.test.mjs tests/checks.test.mjs
npm run typecheck
```

Targeted GREEN result:

```text
tests: 8
pass: 8
fail: 0
typecheck: pass
```

## Final verification

Integrated targeted command:

```text
node --test tests/execution-boundary.test.mjs tests/architecture-boundary.test.mjs tests/checks.test.mjs tests/ssot.test.mjs
```

Integrated targeted result:

```text
tests: 37
pass: 37
fail: 0
```

Full-suite command:

```text
npm test
```

Full-suite result:

```text
pretest build: pass
tests: 239
pass: 237
fail: 0
skipped: 2
```

The two skips are the existing Windows-only command-shim cases.
`git diff --check` also completed without errors before commit.

## Files owned by this correction

- `src/checks.ts`
- `ssot/architecture.json`
- `tests/execution-boundary.test.mjs`
- `.superpowers/sdd/checks-di-report.md`

Concurrent documentation, session, isolation, and architecture-boundary edits
were not modified or staged by this correction.
