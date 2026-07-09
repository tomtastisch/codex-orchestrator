# Usage Guide

This guide walks through using Codex Orchestrator once it is installed (see
[`installation.md`](installation.md) — currently the Installation section of the
[root README](../README.md)). The MCP prompts and tools reference lives in the
[README](../README.md#mcp-prompts-and-tools).

## From a goal to a confirmed change

A minimal end-to-end walkthrough of what the orchestrator actually does. Claude
drives these tool calls; the server enforces the gates.

**1. Goal → plan.** Claude turns a request ("add input validation to the signup
endpoint and cover it with tests") into a persistent, gated plan:

```jsonc
cluster_plan({
  goal: "Validate signup input and test it",
  repo_path: "/path/to/app",
  clusters: [{
    id: "C1", name: "signup-validation", goal: "Reject invalid signups + tests",
    acceptance: ["invalid email/'' password rejected with 400", "new unit tests pass"],
    model_policy: { model: "gpt-5.5", effort: "high", sandbox: "workspace-write" },
    review_strategy: { checks: ["npm_test", "typecheck"] }
  }]
})
// → { plan_id: "P_…", clusters: [{ id: "C1", status: "planned" }] }
```

**2. Start the gate, delegate to Codex.**

```jsonc
cluster_transition({ cluster_id: "C1", action: "start" })   // → status: "active"
hypotheses({
  action: "create", plan_id: "P_…", cluster_id: "C1",
  initial_assumption: "Input validation can be added without changing valid requests",
  confidence_before: 0.8,
  critical_questions: ["Which clients rely on current coercion?"],
  falsification_plan: ["Run existing compatibility tests"]
})
// → { hypothesis: { id: "H_…" } }
task_start({
  cluster_id: "C1", hypothesis_id: "H_…",
  sandbox: "workspace-write", model: "gpt-5.5", effort: "high",
  slice_budget: { max_minutes: 10 }, wait_for: "started", worktree: "auto",
  instructions: "Add validation to the signup handler; add unit tests. Report a SLICE_RESULT.",
  acceptance_criteria: ["invalid signups rejected with 400", "new tests pass"]
})
// → { task_id: "T_…", status: "running", worktree: "…/worktrees/T_…" }
```

**3. Supervise the slices.** Claude long-polls and reacts:

```jsonc
task_wait({ task_id: "T_…", cursor: 0 })
// checkpoint → optionally task_control({ action: "inject", message: "also trim whitespace" })
// submission → the SLICE_RESULT reports: tests "npm test: pass"
```

**4. Review — and the gate that makes it trustworthy.** The server independently
re-runs the declared checks; a self-reported "pass" that actually exited non-zero
is caught and the submission is refused.

```jsonc
cluster_transition({ cluster_id: "C1", action: "submit" })
cluster_transition({ cluster_id: "C1", action: "review", payload: { status: "confirmed" } })
// runs npm_test + typecheck server-side

cluster_transition({ cluster_id: "C1", action: "confirm" })
// ✗ if a check is red   → { ok: false, error: "confirm verweigert", reasons: ["Check 'npm_test' exit=1"] }
// ✓ if all green        → { ok: true, status: "confirmed" }
```

If review found problems instead: `request_changes` → a targeted correction task
resumes the same Codex session, then back to review.

**5. Confirm → retro → durable snapshot.**

```jsonc
cluster_transition({ cluster_id: "C1", action: "retro", payload: { content: "…lessons…" } })
cluster_merge({ cluster_id: "C1", task_id: "T_…" })       // merge the reviewed worktree
plan_snapshot({ plan_id: "P_…", format: "toon" })          // compact, compaction-proof state
```

The point: **"Codex says done" never ends a cluster** — only a passing review plus
green server-run checks does. Everything above is persisted, so the workflow
survives context compaction and server restarts.

## Per-task model & effort control

Every task specifies **which model** does the work and **how hard it thinks**:

```jsonc
{
  "model": "gpt-5.5",          // or "auto", validated against models_list
  "effort": "xhigh",            // low | medium | high | xhigh
  "sandbox": "read-only",       // or workspace-write
  "slice_budget": { "max_minutes": 8 }
}
```

Invalid combinations are rejected before Codex is ever started. The escalation
rule (two failed correction slices → next effort step or stronger model) is part
of the skill and the `models_list` output.

## Staying up to date

See [Staying up to date](../README.md#staying-up-to-date) in the README for the
plugin marketplace update flow and the `codex_update` tool.
