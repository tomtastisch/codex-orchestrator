# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Changed

- Reconciled README platform, installation, prompt, tool, authentication and
  distribution claims with the released 1.5.2 implementation.
- Corrected Anthropic distribution terminology: reviewed third-party
  submissions target `claude-community`; `claude-plugins-official` is curated
  separately and has no application process.
- Added an automated release workflow that runs after green main CI on version
  changes and retains exactly one current stable GitHub release and version
  tag while preserving history in this changelog and Git.

## 1.5.2 - 2026-07-06

### Fixed

- Removed the Claude Desktop installation-time project selector that could
  persist a broad or stale path and terminate the MCP server during
  initialization.
- Return controlled tool errors when a repository stored by an existing plan is
  later removed or becomes inaccessible.
- Made the Desktop extension zero-config: it starts without a project path and
  explicitly removes an inherited `ORCH_PROJECT_DIR` before loading the server.
- Added an optional `repo_path` argument to the `codex_orchestrator` MCP prompt.
  When it is absent, Claude is instructed to ask for the exact absolute Git
  repository root and never infer it. An explicitly supplied empty value is
  rejected instead of being treated as absent.

### Security

- Validate every direct, planned and persisted repository path as the canonical
  root of a Git working tree at request time.
- Reject attempts to update an existing plan through a different repository,
  even when both paths are otherwise valid Git roots.
- Allow multiple repositories through one global Desktop installation without
  weakening the per-request repository boundary.
- Restrict worktree selection to the validated repository or a server-managed
  `worktree: auto`; arbitrary caller-supplied worktree paths are rejected.
- Supersedes 1.5.1, whose installation-time boundary could make an otherwise
  valid extension installation unavailable after startup.

## 1.5.1 - 2026-07-06

### Security

- Require the Claude Desktop `project_directory` to be the canonical root of
  one Git working tree before the MCP server starts.
- Enforce that every direct, planned and persisted repository path is exactly
  the configured Desktop repository; sibling, parent and nested paths fail
  closed.
- Disable caller-supplied worktree paths in Desktop mode; only the selected
  repository or server-managed `worktree: auto` paths are allowed.
- Removed the unsafe ability to select a broad home directory as the Desktop
  project boundary.

## 1.5.0 - 2026-07-06

### Added

- Added two transport-neutral MCP prompts for starting and inspecting an
  orchestration workflow from MCP clients outside Claude Code.
- Added a Claude Desktop MCP Bundle with fail-closed project-directory
  selection and no credential configuration.
- Added deterministic MCPB packaging, SHA-256 generation, archive allowlist
  validation and an extracted end-to-end MCP smoke test.

### Security

- The Desktop bundle contains only its manifest, license, launcher and bundled
  server; it never requests, copies or packages Codex credentials.
- The launcher rejects missing, relative, inaccessible and non-directory
  project paths before starting the MCP server.
- The MCPB build dependency is pinned and its vulnerable transitive `tmp`
  version is overridden with the audited patched release.

## 1.4.1 - 2026-07-06

### Documentation

- Added the exact Claude Code, Codex CLI and authentication prerequisites.
- Added installation, verification, update and removal commands.
- Distinguished the first-party marketplace from Anthropic's official
  marketplace.
- Published the Claude Desktop MCPB and claude.ai Remote MCP roadmap.

## 1.4.0 - 2026-07-06

### Added

- Real loopback OpenSSH acceptance tests for worker deployment, synthetic
  slices and persistent remote authentication across fresh target instances.
- Optional real-auth acceptance mode that validates the local Codex credential
  without executing a model turn.
- Enforced release budgets for bundle size, MCP cold start and Doctor latency.

### Fixed

- Propagated the configured remote `codexHome` through Doctor, authentication
  and every Codex slice, including remote `~/` expansion, so the same
  persistent credential store is always used.
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
