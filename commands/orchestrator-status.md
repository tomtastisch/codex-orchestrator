---
description: Show the current Codex Orchestrator state — plan, clusters, hypotheses and review status — from the persistent store.
argument-hint: [plan_id (optional)]
---

Report the current orchestration state from the **persistent store**, not from
chat context.

1. Ensure the `codex-orchestrator` MCP server is connected. If its tools are
   missing, tell the user to enable the plugin's MCP server and stop.

2. Call `plan_snapshot` (format `toon`) for the plan. If a plan id was provided
   in `$ARGUMENTS`, use it; otherwise use the most recent plan.

3. Summarise concisely:
   - each cluster with its status (planned / active / submitted / in_review /
     needs_changes / confirmed …) and whether its declared checks are green,
   - open vs. confirmed/rejected hypotheses (including versioned rich
     hypotheses via `hypotheses → list`), and their latest result,
   - any blockers or clusters awaiting a decision from the user.

Do not dump full diffs or logs — reference the summaries only.
