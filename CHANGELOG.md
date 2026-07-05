# Changelog

All notable changes to this project are documented in this file.

## 1.2.0 - 2026-07-05

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
