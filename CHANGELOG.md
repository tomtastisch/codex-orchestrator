# Changelog

All notable changes to this project are documented in this file.

## 1.4.0 - 2026-07-06

### Added

- Real loopback OpenSSH acceptance tests for worker deployment, synthetic
  slices and persistent remote authentication across fresh target instances.
- Optional real-auth acceptance mode that validates the local Codex credential
  without executing a model turn.
- Enforced release budgets for bundle size, MCP cold start and Doctor latency.

### Fixed

- Propagated the configured remote `codexHome` through Doctor, authentication
  and every Codex slice so the same persistent credential store is always used.
- Added explicit SSH config-file support to keep non-default and isolated SSH
  installations deterministic.

### Changed

- Removed obsolete plugin self-update code and its isolated tests.
- Consolidated runtime redaction behind the canonical redaction implementation.
- Added benchmark and real-OpenSSH acceptance gates to CI.

### Security

- Remote acceptance credentials and SSH keys are ephemeral, owner-only and
  removed together with the owned test daemon after every run.
- Restart persistence is verified after deleting the local credential source;
  credential contents never appear in test output.

## 1.3.1 - 2026-07-05

### Fixed

- Removed the legacy command that duplicated the user-invocable
  `codex-orchestrator` plugin skill in Claude's component inventory.

## 1.3.0 - 2026-07-05

### Added

- SSH execution targets with a versioned, schema-validated remote worker.
- Fail-closed target preflight, repository identity checks and
  connectivity-only local fallback.
- Persistent remote Codex authentication using private `auth.json`
  synchronization or secret-manager-backed access-token login.
- Remote worktree creation, checks, diff limits, gated merge and cleanup.
- `orchestrator_doctor` for redacted installation, version and authentication
  diagnostics.
- User-invocable `/codex-orchestrator:codex-orchestrator [Auftrag]` skill.

### Security

- Child processes now receive purpose-specific allowlisted environments.
- Credentials are size-limited, never passed in process arguments, written
  atomically with private permissions and cleared from mutable buffers.
- Remote paths, SSH aliases, worker requests, checks and Git operations are
  validated before execution.
- Merge eligibility now requires task ownership, completed work, a confirmed
  review and green declared checks.

### Changed

- Plugin state is stored under `${CLAUDE_PROJECT_DIR}/.orchestrator` so it
  survives plugin cache updates and process restarts.
- Bundled server and worker artifacts are reproducibly verified in CI.
- Plugin self-update was removed from runtime; Claude's marketplace lifecycle
  is the authoritative installation and update mechanism.
