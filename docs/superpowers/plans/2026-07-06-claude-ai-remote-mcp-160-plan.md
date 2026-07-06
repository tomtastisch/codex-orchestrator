# claude.ai Remote MCP 1.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-hosted, single-tenant, OAuth-protected Streamable HTTP connector that lets claude.ai supervise Codex on an operator-controlled host.

**Architecture:** Extract one reusable orchestrator runtime and MCP server factory, retain stdio adapters for Claude Code/Desktop and add a stateful Streamable HTTP adapter. Protect HTTP with issuer/audience-validated OIDC JWTs and per-tool read/write scopes; deploy as an unprivileged container with persistent Codex and orchestrator volumes.

**Tech Stack:** TypeScript, MCP SDK 1.29.0, Express 5.2.1, jose 6.2.3, Docker/Compose, OIDC/JWKS, Node.js test runner.

**Precondition:** Release 1.5.0 is merged, tagged and its final MCPB artifact is installed in Claude Desktop. Start this plan from that `origin/main` on a new `codex/claude-ai-remote-mcp` worktree branch.

---

### Task 1: Extract a reusable server factory without behavior drift

**Files:**
- Create: `src/orchestrator/runtime.ts`
- Create: `src/orchestrator/server.ts`
- Create: `src/entrypoints/stdio.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Modify: `tests/baseline.test.mjs`
- Create: `tests/server-factory.test.mjs`

- [ ] **Step 1: Write a failing two-server factory test**

Create two temporary `ORCH_HOME` directories, call the proposed
`createOrchestratorRuntime()` twice and `createOrchestratorServer(runtime)` once
per runtime. Connect each with an in-memory transport and assert both list the
same 17 tools and 2 prompts while state written to one store is absent in the
other.

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/server-factory.test.mjs`

Expected: module-not-found for `dist/orchestrator/server.js`.

- [ ] **Step 3: Move runtime ownership into a focused module**

Define:

```ts
export interface OrchestratorRuntime {
  config: OrchestratorConfig;
  store: Store;
  execution: ReturnType<typeof createExecutionRuntime>;
  sessions: SessionManager;
  hypotheses: HypothesisRepo;
  machine: ClusterStateMachine;
  worktrees: WorktreeManager;
  close(signal?: string): Promise<void>;
}

export function createOrchestratorRuntime(configuration: OrchestratorConfig): OrchestratorRuntime;
```

Move instance-guard, reaper and shutdown ownership from top-level `server.ts` to
this module. `close()` must terminate owned sessions, close SQLite and remove
only its own instance marker.

- [ ] **Step 4: Convert tool registration into a factory**

Move registrations to:

```ts
export function createOrchestratorServer(runtime: OrchestratorRuntime, policy: AuthorizationPolicy): McpServer;
```

All callbacks resolve dependencies from `runtime`; no module-level Store,
SessionManager or WorktreeManager remains. Keep exact tool names and schemas.

- [ ] **Step 5: Make stdio an adapter**

`src/entrypoints/stdio.ts` creates config/runtime/server, connects
`StdioServerTransport`, logs the redacted startup line and registers graceful
shutdown. Keep `src/server.ts` as a compatibility import of `entrypoints/stdio`.
Update bundle script entrypoint to `src/entrypoints/stdio.ts` only after the
compatibility test passes.

- [ ] **Step 6: Verify no behavior drift**

Run: `npm test && npm run bundle && npm run verify:bundle && node scripts/bundlecheck.mjs`

Expected: existing tests remain green, 17 tools and 2 prompts are reported.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator src/entrypoints/stdio.ts src/server.ts package.json tests/server-factory.test.mjs tests/baseline.test.mjs bundle
git commit -m "refactor: separate orchestrator core from stdio"
```

### Task 2: Add transport-aware authorization scopes

**Files:**
- Create: `src/auth/authorization.ts`
- Modify: `src/orchestrator/server.ts`
- Create: `tests/authorization.test.mjs`

- [ ] **Step 1: Write the failing scope-matrix test**

Use this exact classification:

```ts
export const TOOL_SCOPES = {
  audit_log: "orchestrator:read",
  models_list: "orchestrator:read",
  task_events: "orchestrator:read",
  task_result: "orchestrator:read",
  plan_snapshot: "orchestrator:write",
  orchestrator_doctor: "orchestrator:write",
  cluster_plan: "orchestrator:write",
  cluster_transition: "orchestrator:write",
  cluster_merge: "orchestrator:write",
  codex_update: "orchestrator:write",
  hypotheses: "orchestrator:write",
  repo_check: "orchestrator:write",
  result_artifact: "orchestrator:write",
  task_control: "orchestrator:write",
  task_start: "orchestrator:write",
  task_wait: "orchestrator:read",
  user_decision: "orchestrator:write"
} as const;
```

Tests must assert all 17 tools appear exactly once, local trusted policy permits
missing auth, remote policy rejects missing auth, read tokens cannot call write
tools and write tokens imply read.

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/authorization.test.mjs`

Expected: module-not-found for `dist/auth/authorization.js`.

- [ ] **Step 3: Implement policy and callback wrapper**

Define:

```ts
export type OrchestratorScope = "orchestrator:read" | "orchestrator:write";
export interface AuthorizationPolicy { mode: "trusted-local" | "oauth"; }
export function authorizeTool(tool: keyof typeof TOOL_SCOPES, policy: AuthorizationPolicy, auth?: AuthInfo): void;
```

For `oauth`, require `auth`, require exact tool scope, and accept write as
satisfying read. Throw `McpError(ErrorCode.InvalidRequest, "insufficient_scope")`
without including token or claims. Wrap every registered tool callback centrally.

- [ ] **Step 4: Verify GREEN and local compatibility**

Run: `npm run build && node --test tests/authorization.test.mjs tests/server-factory.test.mjs`

Expected: scope matrix passes and stdio remains usable without OAuth.

- [ ] **Step 5: Commit**

```bash
git add src/auth/authorization.ts src/orchestrator/server.ts tests/authorization.test.mjs
git commit -m "feat: enforce transport-aware tool scopes"
```

### Task 3: Verify OIDC access tokens fail closed

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/auth/oidc-verifier.ts`
- Create: `tests/oidc-verifier.test.mjs`

- [ ] **Step 1: Install pinned runtime dependencies**

```bash
npm install --save-exact express@5.2.1 jose@6.2.3
npm install --save-dev --save-exact @types/express@5.0.6
```

- [ ] **Step 2: Write JWT validation tests**

Generate an ephemeral RSA key pair with `jose`, expose its public JWK through a
loopback JWKS server and test valid token plus rejection of wrong signature,
issuer, audience, expired token, future `nbf`, missing scope and non-HTTPS
issuer configuration.

- [ ] **Step 3: Implement the SDK verifier**

```ts
export interface OidcConfig {
  issuer: URL;
  audience: string;
  jwksUri: URL;
}

export class OidcJwtVerifier implements OAuthTokenVerifier {
  constructor(config: OidcConfig);
  async verifyAccessToken(token: string): Promise<AuthInfo>;
}
```

Use `createRemoteJWKSet` and `jwtVerify` with explicit `issuer`, `audience`,
`algorithms: ["RS256", "ES256", "EdDSA"]`, clock tolerance at most 30 seconds
and a 10-second JWKS timeout. Parse `scope` only as a space-delimited string,
require a nonempty `sub` or `client_id`, and return scopes without logging token
or raw claims.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && node --test tests/oidc-verifier.test.mjs`

Expected: valid token accepted and every malformed/incorrect token rejected.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/auth/oidc-verifier.ts tests/oidc-verifier.test.mjs
git commit -m "feat: validate remote MCP OIDC tokens"
```

### Task 4: Implement the Streamable HTTP server

**Files:**
- Create: `src/http/config.ts`
- Create: `src/http/app.ts`
- Create: `src/entrypoints/http.ts`
- Create: `tests/http-server.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing HTTP contract tests**

Start on loopback port 0 and assert:

- `/health/live` returns 200 with `{ "status": "live" }`;
- `/health/ready` returns redacted version and Doctor readiness only;
- `/mcp` without bearer token returns 401 and protected-resource metadata URL;
- valid read token initializes MCP and lists tools/prompts;
- read token calling `task_start` returns `insufficient_scope`;
- write token reaches the existing tool validation;
- invalid Host and Origin are rejected;
- body over 1 MiB returns 413;
- DELETE closes only the addressed MCP session.

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/http-server.test.mjs`

Expected: module-not-found for `dist/http/app.js`.

- [ ] **Step 3: Add strict environment configuration**

`src/http/config.ts` must require and validate:

```text
ORCH_HTTP_PUBLIC_URL=https://orchestrator.example.com
ORCH_OIDC_ISSUER=https://id.example.com/
ORCH_OIDC_AUDIENCE=https://orchestrator.example.com/mcp
ORCH_OIDC_JWKS_URI=https://id.example.com/.well-known/jwks.json
ORCH_HTTP_ALLOWED_HOSTS=orchestrator.example.com
ORCH_HTTP_PORT=3000
```

Public URL, issuer and JWKS must be HTTPS outside explicit test mode. Reject
unknown protocols, fragments, userinfo, wildcard hosts and invalid ports.

- [ ] **Step 4: Build the HTTP application**

Use `express`, `StreamableHTTPServerTransport`,
`mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl` and
`requireBearerAuth`. Keep a `Map<string, Session>` with server, transport and
last activity. Create a new runtime/server/transport only for valid initialize
requests, route subsequent requests by `Mcp-Session-Id`, cap sessions, expire
idle sessions and close them deterministically. Disable `x-powered-by`, enforce
JSON content type and use explicit body/header/request timeouts.

- [ ] **Step 5: Add the HTTP entrypoint**

`src/entrypoints/http.ts` loads config, creates the app, binds only configured
host/port and installs SIGINT/SIGTERM shutdown that stops accepting requests,
closes sessions, closes runtime and exits non-zero on forced timeout.

Add scripts:

```json
"start:http": "node dist/entrypoints/http.js",
"bundle:http": "esbuild src/entrypoints/http.ts --bundle --platform=node --target=node22 --format=esm --outfile=bundle/http.mjs --external:node:*"
```

- [ ] **Step 6: Verify GREEN**

Run: `npm run build && node --test tests/http-server.test.mjs && npm run bundle:http`

Expected: all HTTP/auth/session tests pass and `bundle/http.mjs` is generated.

- [ ] **Step 7: Commit**

```bash
git add src/http src/entrypoints/http.ts tests/http-server.test.mjs package.json bundle/http.mjs
git commit -m "feat: expose OAuth-protected Streamable HTTP MCP"
```

### Task 5: Build a hardened single-tenant container

**Files:**
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `deploy/.env.example`
- Create: `deploy/README.md`
- Create: `scripts/container-smoke.mjs`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write container policy assertions**

Create a test that parses Compose and asserts non-root user, read-only root,
`no-new-privileges`, dropped capabilities, explicit healthcheck, named state and
Codex volumes, no inline secret values, no Docker socket and an explicit
repository mount sourced from `ORCH_REPOSITORY_PATH`.

- [ ] **Step 2: Create the multi-stage image**

Build bundles in `node:22-bookworm-slim`; runtime stage installs Git, OpenSSH
client and `@openai/codex@0.142.5`, creates
UID/GID 10001, copies only bundles/package metadata/LICENSE and starts
`bundle/http.mjs`. Do not copy source, tests, local auth or `.git`.

- [ ] **Step 3: Create the Compose reference**

Use `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`,
`security_opt: [no-new-privileges:true]`, resource limits, restart policy,
localhost-only port by default, persistent volumes for `/home/orchestrator/.codex`
and `/var/lib/codex-orchestrator`, and an explicit read/write repository mount
configured through `ORCH_REPOSITORY_PATH`. The resource server needs issuer,
audience and JWKS URL but no OIDC client secret; the Claude connector's client
secret stays in Claude's connector configuration and the operator IdP.

- [ ] **Step 4: Add smoke and CI gates**

Build image, inspect config, start with synthetic loopback IdP/Fake-Codex test
mode, wait for health, run HTTP MCP handshake, stop stack and assert volumes do
not contain canary tokens in logs. Add a dedicated `container` CI job.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile compose.yaml .dockerignore deploy scripts/container-smoke.mjs .github/workflows/ci.yml tests
git commit -m "build: add hardened remote MCP deployment"
```

### Task 6: Release and connect version 1.6.0

**Files:**
- Modify: all version sources, `README.md`, `CHANGELOG.md`
- Create: `docs/distribution/claude-ai-connector.md`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Document the operator runbook**

Document domain/TLS, OIDC client creation with Claude callback
`https://claude.ai/api/mcp/auth_callback`, scopes, Codex login on host,
repository mounts, backup/restore, rotation, revocation, upgrades and incident
cleanup. Explicitly forbid uploading local `auth.json` through Claude.

- [ ] **Step 2: Set 1.6.0 and execute all gates**

Run every Claude Code, MCPB, HTTP, OAuth, container, audit, benchmark and real
OpenSSH test. Perform a repository-wide secret scan and `git diff --check`.

- [ ] **Step 3: Publish immutable artifacts**

After PR merge and green CI, create GitHub release 1.6.0, attach MCPB and
checksums, publish the container with version and digest tags, generate SBOM and
provenance, and verify the pulled digest rather than the local image.

- [ ] **Step 4: Deploy the single-tenant connector**

Deploy on the operator-controlled host, complete Codex login there, configure
TLS/OIDC and verify health plus MCP Inspector. No deployment is called complete
without a real HTTPS URL and successful OAuth flow.

- [ ] **Step 5: Connect claude.ai manually**

Add the HTTPS `/mcp` URL in Claude Settings → Connectors, complete OAuth, enable
only required tools, verify 17 tools and 2 prompts, run Doctor, then execute one
bounded disposable-repository workflow. Record only non-secret evidence.

- [ ] **Step 6: Prepare directory submission**

Submit the verified connector to the Anthropic Connectors Directory using its
final HTTPS URL, security documentation and GitHub release. Mark README as
`Submitted` only after acknowledgement and `Officially listed` only after a
visible directory entry.
