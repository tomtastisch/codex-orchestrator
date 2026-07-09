import type { ClusterRow, PersistenceStore } from "./ports/persistence.js";
import type { ClusterStatus } from "./types.js";

export type TransitionAction =
  | "start"
  | "submit"
  | "review"
  | "request_changes"
  | "confirm"
  | "block"
  | "retro"
  | "replan";

export interface TransitionResult {
  ok: boolean;
  cluster_id: string;
  status: ClusterStatus;
  error?: string;
  details?: Record<string, unknown>;
}

/** @typedef MergeEligibilityInput */
export interface MergeEligibilityInput {
  clusterId: string;
  taskClusterId: string | null;
  taskStatus: string;
  clusterStatus: string;
  reviewStatus: string | null;
  checksGreen: boolean;
}

/** @typedef Eligibility */
export interface Eligibility {
  ok: boolean;
  reasons: string[];
}

export function mergeEligibility(input: MergeEligibilityInput): Eligibility {
  const reasons: string[] = [];
  if (input.clusterStatus !== "confirmed") reasons.push("cluster_not_confirmed");
  if (input.reviewStatus !== "confirmed") reasons.push("review_not_confirmed");
  if (!input.checksGreen) reasons.push("checks_not_green");
  if (input.taskClusterId !== input.clusterId) reasons.push("task_cluster_mismatch");
  if (input.taskStatus !== "completed") reasons.push("task_not_completed");
  return { ok: reasons.length === 0, reasons };
}

interface ReviewStrategy {
  checks?: string[];
  codex_review?: boolean;
  notes?: string;
}

function parseStrategy(json: string): ReviewStrategy {
  try {
    return JSON.parse(json) as ReviewStrategy;
  } catch {
    return {};
  }
}

/** Erlaubte Statusübergänge (Plan §6.2). */
const ALLOWED: Record<TransitionAction, ClusterStatus[]> = {
  start: ["planned", "needs_changes", "replanning"],
  submit: ["active", "needs_changes"],
  review: ["submitted"],
  request_changes: ["in_review"],
  confirm: ["in_review"],
  block: ["active", "submitted", "in_review", "needs_changes"],
  retro: ["confirmed"],
  replan: ["active", "submitted", "in_review", "needs_changes", "blocked", "confirmed"],
};

export class ClusterStateMachine {
  constructor(private store: PersistenceStore) {}

  /** Prüft, ob Cluster N gestartet werden darf (Vorgänger confirmed + Retro). */
  private predecessorsReady(cluster: ClusterRow): { ok: boolean; blocking: string[] } {
    if (cluster.parallel_ok) return { ok: true, blocking: [] };
    const all = this.store.listClusters(cluster.plan_id);
    const blocking: string[] = [];
    for (const c of all) {
      if (c.ordinal >= cluster.ordinal) continue;
      if (c.status !== "confirmed") {
        blocking.push(`${c.id} ist ${c.status}, nicht confirmed`);
        continue;
      }
      const retro = this.store.db
        .prepare("SELECT COUNT(*) AS n FROM retros WHERE cluster_id=?")
        .get(c.id) as { n: number };
      if (retro.n === 0) blocking.push(`${c.id} confirmed, aber Retrospektive fehlt`);
    }
    return { ok: blocking.length === 0, blocking };
  }

  /** Prüft, ob offene Review-Findings durch eine Nutzerentscheidung freigegeben sind. */
  private findingsCleared(cluster: ClusterRow, review: any): { ok: boolean; reason?: string } {
    let findings: unknown = null;
    try { findings = JSON.parse(review?.findings_json ?? "null"); } catch { /* ignore */ }
    const hasFindings = Array.isArray(findings) && findings.length > 0;
    if (!hasFindings) return { ok: true };
    // Auffälligkeiten -> es braucht eine explizite Nutzerentscheidung (oder stehende Präferenz).
    const accepts = (d: any) => d && (d.decision === "accept" || d.decision === "proceed");
    const pref = this.store.standingPreference(cluster.plan_id, "cluster_findings");
    if (accepts(pref)) return { ok: true };
    const decision = this.store.latestDecision(cluster.id, "cluster_findings");
    if (accepts(decision)) return { ok: true };
    return {
      ok: false,
      reason:
        `Review meldet ${(findings as unknown[]).length} Auffälligkeit(en) — Abschluss blockiert bis zur ` +
        "Nutzerentscheidung (user_decision topic='cluster_findings', decision 'accept'|'fix').",
    };
  }

  /** Harte confirm-Bedingung (Plan §6.2): REVIEW=confirmed UND alle Checks grün UND Findings freigegeben. */
  private confirmConditions(cluster: ClusterRow): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const review = this.store.latestReview(cluster.id);
    if (!review) {
      reasons.push("kein REVIEW_RESULT vorhanden");
    } else if (review.status !== "confirmed") {
      reasons.push(`REVIEW_RESULT-Status ist '${review.status}', nicht 'confirmed'`);
    } else {
      // Cluster 4: Auffälligkeiten blockieren Abschluss bis zur Nutzerentscheidung.
      const cleared = this.findingsCleared(cluster, review);
      if (!cleared.ok) reasons.push(cleared.reason!);
    }
    const strategy = parseStrategy(cluster.review_strategy_json);
    const declared = strategy.checks ?? [];
    const checks = this.store.checksForCluster(cluster.id);
    for (const name of declared) {
      const latest = [...checks].reverse().find((c) => c.cmd === name);
      if (!latest) reasons.push(`deklarierter Check '${name}' wurde nicht ausgeführt`);
      else if (latest.exit_code !== 0) reasons.push(`Check '${name}' exit=${latest.exit_code} (nicht grün)`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  transition(clusterId: string, action: TransitionAction, payload: any = {}): TransitionResult {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) return { ok: false, cluster_id: clusterId, status: "planned", error: "unbekannter Cluster" };

    const allowedFrom = ALLOWED[action];
    if (!allowedFrom.includes(cluster.status)) {
      return {
        ok: false, cluster_id: clusterId, status: cluster.status,
        error: `Übergang '${action}' aus Status '${cluster.status}' nicht erlaubt (erlaubt aus: ${allowedFrom.join(", ")})`,
      };
    }

    switch (action) {
      case "start": {
        const pre = this.predecessorsReady(cluster);
        if (!pre.ok) {
          return { ok: false, cluster_id: clusterId, status: cluster.status,
            error: "Vorbedingungen nicht erfüllt", details: { blocking: pre.blocking } };
        }
        this.store.setClusterStatus(clusterId, "active");
        return { ok: true, cluster_id: clusterId, status: "active" };
      }
      case "submit":
        this.store.setClusterStatus(clusterId, "submitted");
        return { ok: true, cluster_id: clusterId, status: "submitted" };
      case "review": {
        // REVIEW_RESULT persistieren (Format v1 §18, hier als strukturiertes Objekt).
        const status = String(payload.status ?? "");
        if (status !== "confirmed" && status !== "needs_changes") {
          return {
            ok: false,
            cluster_id: clusterId,
            status: cluster.status,
            error: "Review-Status muss 'confirmed' oder 'needs_changes' sein",
          };
        }
        this.store.addReview(
          clusterId, status, payload.findings ?? null, payload.fixes ?? null, payload.impact ?? null,
        );
        this.store.setClusterStatus(clusterId, "in_review");
        return { ok: true, cluster_id: clusterId, status: "in_review",
          details: { recorded_review_status: status } };
      }
      case "request_changes":
        this.store.setClusterStatus(clusterId, "needs_changes");
        return { ok: true, cluster_id: clusterId, status: "needs_changes" };
      case "confirm": {
        const cond = this.confirmConditions(cluster);
        if (!cond.ok) {
          // Kernintention v1 §16: "Codex sagt done" bleibt strukturell wirkungslos.
          return { ok: false, cluster_id: clusterId, status: cluster.status,
            error: "confirm verweigert: Bedingungen nicht erfüllt", details: { reasons: cond.reasons } };
        }
        this.store.setClusterStatus(clusterId, "confirmed");
        return { ok: true, cluster_id: clusterId, status: "confirmed" };
      }
      case "block":
        this.store.setClusterStatus(clusterId, "blocked");
        return { ok: true, cluster_id: clusterId, status: "blocked" };
      case "retro": {
        if (!payload.content && !payload.retrospective) {
          return { ok: false, cluster_id: clusterId, status: cluster.status,
            error: "retro erfordert 'content' (CLUSTER_RETROSPECTIVE)" };
        }
        return this.store.tx(() => {
          this.store.addRetro(clusterId, String(payload.content ?? payload.retrospective));
          const updates: any[] = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
          for (const h of updates) {
            if (h?.id && h?.status) this.store.setHypothesis(h.id, h.status, h.evidence ?? null);
          }
          return { ok: true, cluster_id: clusterId, status: "confirmed",
            details: { retro_recorded: true, hypotheses_updated: updates.length } };
        });
      }
      case "replan":
        this.store.setClusterStatus(clusterId, "replanning");
        return { ok: true, cluster_id: clusterId, status: "replanning" };
      default:
        return { ok: false, cluster_id: clusterId, status: cluster.status, error: "unbekannte Aktion" };
    }
  }
}
