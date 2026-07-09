import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { config } from "../../config.js";
import { runChecks, diffSize } from "../../checks.js";
import { repoPathForCluster, latestWorktreeForCluster } from "../../resolve.js";
import { HypothesisRepo, needsFollowUp, type HypothesisResult } from "../../hypotheses.js";

export function registerKnowledgeTools(server: McpServer, ctx: AppContext): void {
  const { store, hypRepo, ok, err, executionTargetForCluster } = ctx;

// ---------------------------------------------------------------- 7.9 hypotheses
server.registerTool(
  "hypotheses",
  {
    title: "Hypothesen führen (versioniert)",
    description:
      "Legacy: list|add|confirm|reject|supersede (plan-weite Freitext-Hypothesen). " +
      "Reiches, versioniertes Modell: create|update|get|versions. " +
      "'create' bildet die Pflicht-Hypothese VOR einer Aufgabe (initialAssumption + criticalQuestions + falsificationPlan). " +
      "'update' aktualisiert append-only NACH der Aufgabe (result + evidence + updatedAssumption).",
    inputSchema: {
      plan_id: z.string().optional().describe("Für list/add/create (plan-weite Gruppierung)."),
      action: z.enum([
        "list", "add", "confirm", "reject", "supersede",
        "create", "update", "get", "versions",
      ]),
      id: z.string().optional(),
      text: z.string().optional().describe("Legacy add: Freitext."),
      evidence: z.string().optional().describe("Legacy: Provenienz."),
      // --- reiches Modell ---
      task_id: z.string().optional(),
      cluster_id: z.string().optional(),
      initial_assumption: z.string().optional().describe("create: die Ausgangsannahme."),
      confidence_before: z.number().min(0).max(1).optional().describe("create: Konfidenz [0,1] vor der Aufgabe."),
      critical_questions: z.array(z.string()).optional().describe("create: aktives Hinterfragen."),
      falsification_plan: z.array(z.string()).optional().describe("create: wie könnte die Annahme scheitern?"),
      result: z.enum(["open", "confirmed", "partially_confirmed", "refuted"]).optional().describe("update: Prüfergebnis."),
      confidence_after: z.number().min(0).max(1).optional().describe("update: Konfidenz [0,1] nach der Aufgabe."),
      updated_assumption: z.string().optional().describe("update: revidierte Annahme / Folgehypothese."),
      add_evidence: z.array(z.string()).optional().describe("update: gefundene Evidenz."),
      follow_up_questions: z.array(z.string()).optional().describe("update: PFLICHT bei partially_confirmed/refuted — was bleibt offen?"),
      risks: z.array(z.string()).optional().describe("update: erkannte Risiken/Folgeprobleme."),
      next_action: z.string().optional().describe("update: nächste sinnvolle Aktion."),
      status: z.enum(["open", "confirmed", "rejected", "superseded"]).optional(),
      version: z.number().int().positive().optional().describe("get: konkrete Version (sonst neueste)."),
    },
  },
  async (a) => {
    try {
      switch (a.action) {
        case "list":
          if (!a.plan_id) return err({ ok: false, error: "list erfordert 'plan_id'" });
          return ok({
            plan_id: a.plan_id,
            hypotheses: store.listHypotheses(a.plan_id),
            rich: hypRepo.listByPlan(a.plan_id).map((h) => HypothesisRepo.serialize(h)),
          });
        case "add": {
          if (!a.plan_id) return err({ ok: false, error: "add erfordert 'plan_id'" });
          if (!a.text) return err({ ok: false, error: "add erfordert 'text'" });
          const id = store.addHypothesis(a.plan_id, a.text, a.evidence ?? null);
          return ok({ ok: true, id });
        }
        case "confirm":
        case "reject":
        case "supersede": {
          if (!a.id) return err({ ok: false, error: `${a.action} erfordert 'id'` });
          const status = a.action === "confirm" ? "confirmed" : a.action === "reject" ? "rejected" : "superseded";
          store.setHypothesis(a.id, status, a.evidence ?? null);
          return ok({ ok: true, id: a.id, status });
        }
        case "create": {
          if (!a.initial_assumption) return err({ ok: false, error: "create erfordert 'initial_assumption'" });
          if (a.confidence_before === undefined) return err({ ok: false, error: "create erfordert 'confidence_before' [0,1]" });
          const h = hypRepo.create({
            planId: a.plan_id ?? null,
            taskId: a.task_id ?? null,
            clusterId: a.cluster_id ?? null,
            initialAssumption: a.initial_assumption,
            confidenceBefore: a.confidence_before,
            criticalQuestions: a.critical_questions,
            falsificationPlan: a.falsification_plan,
          });
          return ok({ ok: true, hypothesis: HypothesisRepo.serialize(h) });
        }
        case "update": {
          if (!a.id) return err({ ok: false, error: "update erfordert 'id'" });
          const h = hypRepo.update(a.id, {
            status: a.status,
            result: a.result as HypothesisResult | undefined,
            confidenceAfter: a.confidence_after,
            updatedAssumption: a.updated_assumption,
            addEvidence: a.add_evidence,
            followUpQuestions: a.follow_up_questions,
            risks: a.risks,
            nextAction: a.next_action,
            criticalQuestions: a.critical_questions,
            falsificationPlan: a.falsification_plan,
            taskId: a.task_id,
            clusterId: a.cluster_id,
          });
          return ok({ ok: true, needs_follow_up: needsFollowUp(h.result), hypothesis: HypothesisRepo.serialize(h) });
        }
        case "get": {
          if (!a.id) return err({ ok: false, error: "get erfordert 'id'" });
          const h = a.version ? hypRepo.getVersion(a.id, a.version) : hypRepo.get(a.id);
          if (!h) return err({ ok: false, error: `Hypothese ${a.id} (v${a.version ?? "latest"}) nicht gefunden` });
          return ok({ ok: true, hypothesis: HypothesisRepo.serialize(h) });
        }
        case "versions": {
          if (!a.id) return err({ ok: false, error: "versions erfordert 'id'" });
          return ok({ ok: true, id: a.id, versions: hypRepo.listVersions(a.id).map((h) => HypothesisRepo.serialize(h)) });
        }
      }
    } catch (e: any) {
      return err({ ok: false, error: e?.message ?? String(e) });
    }
  },
);


// ---------------------------------------------------------------- 7.9b user_decision
server.registerTool(
  "user_decision",
  {
    title: "Nutzerentscheidungen & Präferenzen (Cluster-Gate)",
    description:
      "record|list|preference. Bei Review-Auffälligkeiten fragt Claude den Nutzer, ob nachgebessert werden soll; " +
      "die Antwort wird hier persistiert. 'accept'/'proceed' gibt den Cluster-Abschluss trotz Findings frei, " +
      "'fix' fordert Nachbesserung. Mit remember=true wird die Antwort zur stehenden Präferenz (plan-weit).",
    inputSchema: {
      action: z.enum(["record", "list", "preference"]),
      plan_id: z.string().optional(),
      cluster_id: z.string().optional(),
      topic: z.string().default("cluster_findings").describe("Entscheidungsthema. Default: Review-Auffälligkeiten."),
      question: z.string().optional().describe("Die dem Nutzer gestellte Frage (für Audit)."),
      decision: z.enum(["accept", "proceed", "fix", "always_ask"]).optional(),
      remember: z.boolean().default(false).describe("Als stehende Präferenz merken (künftig automatisch anwenden)."),
    },
  },
  async (a) => {
    switch (a.action) {
      case "record": {
        if (!a.decision) return err({ ok: false, error: "record erfordert 'decision'" });
        const id = store.recordDecision({
          planId: a.plan_id ?? null,
          clusterId: a.cluster_id ?? null,
          topic: a.topic,
          question: a.question ?? null,
          decision: a.decision,
          remember: a.remember,
        });
        return ok({ ok: true, id, decision: a.decision, remember: a.remember });
      }
      case "list":
        return ok({ ok: true, decisions: store.listDecisions({ clusterId: a.cluster_id, planId: a.plan_id }) });
      case "preference": {
        const pref = store.standingPreference(a.plan_id ?? null, a.topic);
        return ok({ ok: true, topic: a.topic, preference: pref ?? null });
      }
    }
  },
);


// ---------------------------------------------------------------- 7.10 repo_check
server.registerTool(
  "repo_check",
  {
    title: "Allowlisted Repo-Checks",
    description:
      "Führt nur allowlisted Kommandos aus (keine freie Shell). Ergebnisse fließen in die confirm-Bedingung. Prüft zusätzlich Diff-Limits.",
    inputSchema: {
      cluster_id: z.string(),
      checks: z.array(z.string()),
      scope: z.enum(["worktree", "branch"]).default("branch"),
    },
  },
  async (a) => {
    const repo = repoPathForCluster(store, a.cluster_id);
    if (!repo) return err({ ok: false, error: "Plan-Repo für Cluster nicht gefunden" });
    const target = a.scope === "worktree" ? latestWorktreeForCluster(store, a.cluster_id) || repo : repo;
    const executionTarget = executionTargetForCluster(a.cluster_id);
    const res = await runChecks(store, a.cluster_id, target, a.checks, executionTarget);
    let diff = { files: 0, lines: 0 };
    try {
      diff = await diffSize(target, executionTarget);
    } catch { /* ignore */ }
    return ok({
      ok: true,
      cluster_id: a.cluster_id,
      scope: a.scope,
      target,
      runs: res.runs,
      all_green: res.allGreen,
      unknown_checks: res.unknown,
      available_checks: Object.keys(config.checks),
      diff_summary: diff,
      over_diff_limit: diff.lines > config.limits.maxDiffLines || diff.files > config.limits.maxDiffFiles,
    });
  },
);

}
