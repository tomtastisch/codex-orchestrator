import { encode as toonEncode } from "@toon-format/toon";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Store } from "./db.js";

function parse(json: string | null | undefined): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}

/**
 * Baut ein vollständiges, strukturiertes Zustandsobjekt eines Plans.
 * Grundlage für TOON/JSON-Snapshots — ein durables Artefakt, das unabhängig
 * vom (komprimierbaren) Chat-Kontext existiert.
 */
export function buildPlanSnapshot(store: Store, planId: string): any {
  const plan = store.getPlan(planId);
  if (!plan) return null;
  const clusters = store.listClusters(planId).map((c) => ({
    id: c.id,
    ordinal: c.ordinal,
    name: c.name,
    status: c.status,
    goal: c.goal,
    parallel_ok: !!c.parallel_ok,
    tasks: parse(c.tasks_json),
    acceptance: parse(c.acceptance_json),
    risks: parse(c.risks_json),
    model_policy: parse(c.model_policy_json),
    review_strategy: parse(c.review_strategy_json),
    latest_review: (() => {
      const r = store.latestReview(c.id);
      return r ? { status: r.status, ts: r.ts } : null;
    })(),
    checks: store.checksForCluster(c.id).map((k: any) => ({ cmd: k.cmd, exit_code: k.exit_code, ts: k.ts })),
  }));
  const hypotheses = store.listHypotheses(planId).map((h: any) => ({
    id: h.id, status: h.status, text: h.text, evidence: h.evidence, updated_at: h.updated_at,
  }));
  return {
    plan: { id: plan.id, goal: plan.goal, status: plan.status, repo_path: plan.repo_path, constraints: plan.constraints },
    clusters,
    hypotheses,
  };
}

export interface SnapshotResult {
  format: "toon" | "json";
  content: string;
  path: string;
}

export function writePlanSnapshot(store: Store, planId: string, format: "toon" | "json" = "toon"): SnapshotResult | null {
  const snap = buildPlanSnapshot(store, planId);
  if (!snap) return null;
  const content = format === "toon" ? toonEncode(snap) : JSON.stringify(snap, null, 2);
  const dir = join(config.home, "snapshots");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${planId}.${format}`);
  writeFileSync(path, content, "utf8");
  return { format, content, path };
}
