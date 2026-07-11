import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { config } from "../../config.js";
import { mergeEligibility, type TransitionAction } from "../../statemachine.js";
import { isGitRepo } from "../../worktree.js";
import { runChecks } from "../../checks.js";
import { repoPathForCluster, latestWorktreeForCluster } from "../../resolve.js";
import { writePlanSnapshot } from "../../snapshot.js";
import { writeResultArtifact } from "../../artifact.js";
import { type Sandbox } from "../../types.js";
import { assertGitRepositoryRoot } from "../../project-boundary.js";

export function registerPlanningTools(server: McpServer, ctx: AppContext): void {
  const { store, execution, hypRepo, machine, worktrees, ok, err, executionTargetForCluster } = ctx;

// ---------------------------------------------------------------- 7.7 cluster_plan
server.registerTool(
  "cluster_plan",
  {
    title: "Clusterplan anlegen/aktualisieren",
    description: "Persistierter Plan mit Clustern (Gates, Acceptance, Risiken, Modellpolitik, Sandbox, Review-Strategie). Idempotent über plan_id.",
    inputSchema: {
      plan_id: z.string().optional().describe("Weglassen für neuen Plan."),
      goal: z.string(),
      constraints: z.string().optional(),
      repo_path: z.string(),
      clusters: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          goal: z.string(),
          tasks: z.array(z.string()).default([]),
          acceptance: z.array(z.string()).default([]),
          risks: z.array(z.string()).optional(),
          model_policy: z
            .object({
              class: z.enum(["fast", "balanced", "strong"]).default("balanced"),
              effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
              sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
              model: z.string().optional().describe("Konkreter Modellname für diesen Cluster (sonst 'auto')."),
            })
            .default({ class: "balanced", effort: "medium", sandbox: "workspace-write" }),
          review_strategy: z
            .object({ checks: z.array(z.string()).default([]), codex_review: z.boolean().default(false), notes: z.string().optional() })
            .default({ checks: [], codex_review: false }),
          parallel_ok: z.boolean().default(false),
        }),
      ),
    },
  },
  async (a) => {
    let repoPath: string;
    try {
      repoPath = assertGitRepositoryRoot(a.repo_path);
      if (!isGitRepo(repoPath)) {
        return err({ ok: false, error: `Kein git-Repo: ${repoPath}` });
      }
      if (a.plan_id) {
        const existing = store.getPlan(a.plan_id);
        if (existing) {
          const existingRepoPath = assertGitRepositoryRoot(existing.repo_path);
          if (existingRepoPath !== repoPath) {
            throw new Error("repo_path does not match the existing plan repository");
          }
        }
      }
    } catch (e: any) {
      return err({ ok: false, error: e?.message ?? String(e) });
    }
    return store.tx(() => {
      let planId = a.plan_id;
      if (!planId || !store.getPlan(planId)) {
        const p = store.createPlan(a.goal, a.constraints ?? null, repoPath);
        planId = p.id;
      }
      const persisted = a.clusters.map((c, i) =>
        store.upsertCluster({
          id: c.id,
          plan_id: planId!,
          ordinal: i,
          name: c.name,
          goal: c.goal,
          tasks_json: JSON.stringify(c.tasks),
          acceptance_json: JSON.stringify(c.acceptance),
          risks_json: JSON.stringify(c.risks ?? []),
          model_policy_json: JSON.stringify(c.model_policy),
          review_strategy_json: JSON.stringify(c.review_strategy),
          parallel_ok: c.parallel_ok ? 1 : 0,
        }),
      );
      return ok({
        ok: true,
        plan_id: planId,
        clusters: persisted.map((c) => ({ id: c.id, ordinal: c.ordinal, name: c.name, status: c.status })),
      });
    });
  },
);


// ---------------------------------------------------------------- 7.8 cluster_transition
server.registerTool(
  "cluster_transition",
  {
    title: "Cluster-Statusübergang (servererzwungen)",
    description:
      "start|submit|review|request_changes|confirm|block|retro|replan. confirm scheitert ohne REVIEW_RESULT=confirmed UND grüne deklarierte Checks. review führt deklarierte Checks aus (run_checks=false zum Abschalten).",
    inputSchema: {
      cluster_id: z.string(),
      action: z.enum(["start", "submit", "review", "request_changes", "confirm", "block", "retro", "replan"]),
      payload: z.record(z.any()).optional(),
    },
  },
  async (a) => {
    const payload = a.payload ?? {};
    // review: deklarierte Checks vorab ausführen, damit die confirm-Bedingung greifen kann.
    if (a.action === "review" && payload.run_checks !== false) {
      const cluster = store.getCluster(a.cluster_id);
      const repo = repoPathForCluster(store, a.cluster_id);
      if (cluster && repo) {
        const strategy = JSON.parse(cluster.review_strategy_json || "{}");
        const declared: string[] = strategy.checks ?? [];
        if (declared.length) {
          const scope = latestWorktreeForCluster(store, a.cluster_id) || repo;
          const res = await runChecks(store, a.cluster_id, scope, declared, executionTargetForCluster(a.cluster_id));
          payload.checks_run = res.runs;
        }
      }
    }
    const r = machine.transition(a.cluster_id, a.action as TransitionAction, payload);
    return r.ok ? ok(r) : err(r);
  },
);


// -------------------------------------------------- M3-Ergänzung: cluster_merge
server.registerTool(
  "cluster_merge",
  {
    title: "Worktree-Branch mergen (M3, sequenziell nach Review)",
    description:
      "Merged den Branch eines parallelen Tasks erst nach confirmed Cluster/Review und grünen Checks. Konflikt -> Merge wird abgebrochen.",
    inputSchema: {
      cluster_id: z.string(),
      task_id: z.string(),
      no_ff: z.boolean().default(true),
      sign: z.boolean().optional().describe("Merge-Commit signieren. Default: Server-Policy (ORCH_SIGN_MERGE)."),
      cleanup: z.boolean().default(false).describe("Worktree + Branch nach erfolgreichem Merge entfernen."),
    },
  },
  async (a) => {
    const repo = repoPathForCluster(store, a.cluster_id);
    if (!repo) return err({ ok: false, error: "Plan-Repo nicht gefunden" });
    const cluster = store.getCluster(a.cluster_id);
    if (!cluster) return err({ ok: false, error: "Cluster nicht gefunden" });
    const task = store.getTask(a.task_id);
    if (!task || !task.branch) return err({ ok: false, error: "Task ohne Worktree-Branch" });
    const review = store.latestReview(a.cluster_id);
    const strategy = JSON.parse(cluster.review_strategy_json || "{}") as { checks?: string[] };
    const checks = store.checksForCluster(a.cluster_id);
    const checksGreen = (strategy.checks ?? []).every((name) => {
      const latest = [...checks].reverse().find((check) => check.cmd === name);
      return latest?.exit_code === 0;
    });
    const eligibility = mergeEligibility({
      clusterId: cluster.id,
      taskClusterId: task.cluster_id,
      taskStatus: task.status,
      clusterStatus: cluster.status,
      reviewStatus: review?.status ?? null,
      checksGreen,
    });
    if (!eligibility.ok) {
      return err({ ok: false, error: "Merge-Gates nicht erfüllt", reasons: eligibility.reasons });
    }
    const sign = a.sign ?? config.signMergeCommits;
    const target = execution.registry.get(task.target_id);
    const r = target.kind === "ssh" && target.mergeWorktree
      ? await target.mergeWorktree(repo, task.branch, { noFf: a.no_ff, noGpgSign: !sign })
      : worktrees.merge(repo, task.branch, { noFf: a.no_ff, noGpgSign: !sign });
    if (!r.ok) {
      return err({ ok: false, conflict: r.conflict, error: "Merge fehlgeschlagen", output: r.output.slice(-1500) });
    }
    let cleaned = false;
    if (a.cleanup && task.worktree) {
      try {
        if (target.kind === "ssh" && target.removeWorktree) {
          await target.removeWorktree(repo, task.worktree, task.branch);
        } else {
          worktrees.remove(repo, task.worktree, task.branch);
        }
        store.updateTask(task.id, { worktree: null });
        cleaned = true;
      } catch { /* Worktree bleibt für Forensik */ }
    }
    return ok({ ok: true, merged: task.branch, cleaned, output: r.output.slice(-1000) });
  },
);


// -------------------------------------------------- plan_snapshot (TOON/JSON)
server.registerTool(
  "plan_snapshot",
  {
    title: "Plan-Zustand als durables Snapshot (TOON/JSON)",
    description:
      "Schreibt Plan+Cluster+Hypothesen+Reviews+Checks als kompaktes, kompressionssicheres Artefakt (TOON default) nach ORCH_HOME/snapshots und gibt den Inhalt zurück. Gegen Kontext-Kompaktierung.",
    inputSchema: {
      plan_id: z.string(),
      format: z.enum(["toon", "json"]).default("toon"),
    },
  },
  async (a) => {
    const res = writePlanSnapshot(store, a.plan_id, a.format);
    if (!res) return err({ ok: false, error: "Plan nicht gefunden" });
    return ok({ ok: true, format: res.format, path: res.path, content: res.content });
  },
);


// -------------------------------------------------- result_artifact (.toln)
server.registerTool(
  "result_artifact",
  {
    title: "Finales Gesamtartefakt erzeugen (.toln)",
    description:
      "Erzeugt am Ende eines Orchestrator-Laufs ein versioniertes, maschinenlesbares Ergebnisartefakt: " +
      "TOML mit Endung .toln (+ summary.md). Enthält Plan, Cluster, Tasks, Agentenjobs, alle Hypothesen und " +
      "ihre Aktualisierungen, Reviews, Nutzerentscheidungen, geänderte Dateien, Tests, Findings, offene Punkte, " +
      "Gesamtbewertung und Prüfsumme. Registriert das Artefakt in der DB.",
    inputSchema: {
      plan_id: z.string(),
      original_request: z.string().optional(),
      interpreted_goal: z.string().optional(),
      final_assessment: z.string().optional(),
      recommended_next_steps: z.array(z.string()).optional(),
      git_commit_before: z.string().optional().describe("Basis-Commit für die Datei-Diff-Ermittlung (sonst HEAD~1)."),
    },
  },
  async (a) => {
    const res = writeResultArtifact(store, hypRepo, a.plan_id, {
      originalUserRequest: a.original_request,
      interpretedGoal: a.interpreted_goal,
      finalAssessment: a.final_assessment,
      recommendedNextSteps: a.recommended_next_steps,
      gitCommitBefore: a.git_commit_before ?? null,
    });
    if (!res) return err({ ok: false, error: "Plan nicht gefunden" });
    store.addAuditEvent({
      actor: "claude", action: "result_artifact_generated", resource: a.plan_id,
      detail: { path: res.tolnPath, artifactVersion: res.artifact.artifactVersion, checksum: res.artifact.checksum },
      redacted: false,
    });
    return ok({
      ok: true,
      toln_path: res.tolnPath,
      summary_path: res.summaryPath,
      schema_version: res.artifact.schemaVersion,
      artifact_version: res.artifact.artifactVersion,
      checksum: res.artifact.checksum,
      clusters: res.artifact.clusters.length,
      hypotheses: res.artifact.hypotheses.length,
      unresolved: res.artifact.unresolvedIssues.length,
    });
  },
);

}
