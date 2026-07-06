import { config, modelForClass, type ModelClass } from "./config.js";
import type { Store } from "./db.js";
import type { Effort } from "./types.js";
import { assertGitRepositoryRoot } from "./project-boundary.js";

/** Modellname auflösen: 'auto' -> Klasse nach Effort; sonst wörtlich (nie hartkodiert). */
export function resolveModel(model: string, effort: Effort): string {
  if (model && model !== "auto") return model;
  const cls: ModelClass =
    effort === "low" ? "fast" : effort === "high" || effort === "xhigh" ? "strong" : "balanced";
  return modelForClass(cls).model;
}

/** Repo-Pfad zu einem Cluster über den zugehörigen Plan bestimmen. */
export function repoPathForCluster(store: Store, clusterId: string): string | null {
  const cluster = store.getCluster(clusterId);
  if (!cluster) return null;
  const plan = store.getPlan(cluster.plan_id);
  return plan ? assertGitRepositoryRoot(plan.repo_path) : null;
}

/** Worktree-Pfad des jüngsten Tasks eines Clusters (für scope:worktree). */
export function latestWorktreeForCluster(store: Store, clusterId: string): string | null {
  const tasks = store.listTasks({ clusterId });
  const withWt = tasks.filter((t) => t.worktree);
  const last = withWt[withWt.length - 1];
  return last?.worktree ?? null;
}

export { config };
