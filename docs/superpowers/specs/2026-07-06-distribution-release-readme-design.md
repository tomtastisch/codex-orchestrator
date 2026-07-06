# Distribution, release and README design

## Goal

Keep one supported public version of Codex Orchestrator, publish future version
changes reproducibly, and make the README describe the implemented and
released state without conflating first-party, Anthropic-managed and community
directories.

## Current-state decisions

1. Claude Code remains production ready and directly installable from the
   repository's first-party marketplace.
2. Claude Desktop MCPB is released in version 1.5.2. Its bundle, checksum,
   startup, MCP handshake, tools, prompts and Doctor result are technically
   verified. The remaining interactive conversation run is an operator
   acceptance check, not an implementation or release blocker.
3. claude.ai Remote MCP remains planned for 1.6.0 because the current server is
   local stdio and cannot be started by claude.ai.
4. Third-party submissions go to Anthropic's `claude-community` marketplace.
   `claude-plugins-official` is separately curated by Anthropic and has no
   application process.
5. Build with Claude and Cross AI Tools are independent community directories.
   They must never be described as official Anthropic distribution channels.

## Release invariant

GitHub must expose exactly one current stable release and one corresponding
semantic-version tag. Historical versions remain auditable in Git history and
`CHANGELOG.md`, but are not offered as installable releases.

A release workflow runs only after the version in `package.json` changes on
`main`. It validates version agreement, executes all release gates, builds the
MCPB and checksum, publishes the new release, removes older GitHub releases and
semantic-version tags, marks the new release as latest, and verifies the final
one-release/one-tag invariant. Concurrency is serialized to prevent competing
publish operations.

## Documentation contract

Automated tests derive the current version from `package.json` and verify that
the README:

- reports the real status of all three runtimes;
- links to `releases/latest` instead of hard-coding a stale release page;
- documents the current Claude Code, Claude Desktop and remote-auth flows;
- distinguishes first-party, Anthropic community and Anthropic official
  distribution precisely;
- links to the two independent community directories only as discovery
  channels;
- lists every registered MCP tool and prompt;
- states the one-release policy.

The distribution status record is also updated to the current Anthropic
submission route. A status may change to submitted or listed only after an
external acknowledgement or catalog entry exists.

## External publication boundaries

Repository metadata and community-directory contributions may publish only
already-public project data. Anthropic Console authentication or any contact
form that transmits an email address requires the account owner to authenticate
or explicitly authorize that contact detail. No credential, token, `auth.json`
content or private identifier is included in repository files or submissions.
