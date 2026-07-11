# Remote Codex Execution & Persistent Authentication

The orchestrator can run Codex slices on a remote host over SSH while Claude
stays local. Authentication persists across restarts without ever exposing
credentials to Claude.

Create `.orchestrator/config.json` in the project from which Claude is started:

```json
{
  "version": 1,
  "execution": {
    "mode": "remote-preferred",
    "fallback": "connectivity-only",
    "remote": {
      "id": "devbox",
      "transport": "ssh",
      "host": "devbox",
      "repository": {
        "localRoot": "/Users/me/projects",
        "remoteRoot": "/home/me/projects"
      },
      "codexBin": "codex",
      "workerRoot": "~/.cache/codex-orchestrator",
      "codexHome": "~/.codex",
      "auth": {
        "strategy": "sync-file",
        "source": "/Users/me/.codex/auth.json"
      }
    }
  }
}
```

The source must be an owner-controlled regular file with no group or world
permissions (`chmod 600 ~/.codex/auth.json`). The credential is transferred in
the validated worker protocol, written atomically to the persistent remote
`codexHome` with mode `0600`, and never included in task events or tool results.
Every slash-command preflight and task resolves `~/` against the remote user's
home, starts Codex with that exact `CODEX_HOME`, and performs a fresh
`codex login status` check. If the remote file is missing or stale, `sync-file`
installs or refreshes it and then repeats the check. This survives Claude,
plugin and target restarts as long as the remote home directory persists.

For managed environments, use a secret manager command instead of a file:

```json
"auth": {
  "strategy": "access-token",
  "secretCommand": ["security", "find-generic-password", "-s", "codex-access-token", "-w"]
}
```

The command output is passed only through stdin to
`codex login --with-access-token`; it is not stored by the orchestrator.
`existing` is the strictest strategy and fails if the remote Codex installation
is not already authenticated. Local fallback is permitted only for retryable
connectivity errors, never for authentication, host-key, protocol or repository
mismatches.

> Never paste `auth.json`, OAuth tokens or API keys into Claude or into an
> installation command.
