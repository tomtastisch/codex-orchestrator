# Development

```bash
npm ci
npm run build        # TypeScript → dist/
npm test             # unit + contract tests (parser, state machine, isolation) — no API calls
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
OpenSSH transport: it creates ephemeral host and user keys, deploys the actual
worker bundle, bootstraps a synthetic credential, executes one fake Codex slice,
creates a fresh target instance and confirms that authentication still works
after the local source credential has been removed. CI runs this acceptance test
on macOS.

`npm run test:remote:real` repeats the persistence check with the current local
Codex binary and private `auth.json`. It does not execute a model turn. Both
remote tests use only temporary directories, terminate their owned `sshd`
process and remove all temporary keys and credentials before exit.

The release benchmark fails when either bundle exceeds its size budget or when
the p95 MCP cold-start/Doctor latency exceeds its budget. Current limits are
1.25 MiB for `bundle/server.mjs`, 256 KiB for `bundle/worker.mjs`, 2,500 ms for
cold start and 1,500 ms for Doctor. Override only the sample count with
`ORCH_BENCHMARK_ITERATIONS=5..50`; release budgets are intentionally fixed.

## Contributing

- The binding rules for coding agents live in [`../CLAUDE.md`](../CLAUDE.md)
  (Claude) and [`../AGENTS.md`](../AGENTS.md) (Codex).
- New adapters implement the relevant port; boundary contract tests
  (`tests/architecture-boundary.test.mjs`, `tests/execution-boundary.test.mjs`)
  are mandatory and must stay green.
- Central values live once under `ssot/`; never hard-code a value that `ssot/`
  owns.
- See [`review-policy.md`](review-policy.md) for the review and merge gate.
