// Persistence port (hexagonal boundary).
//
// This module defines the abstraction the domain and application layers depend
// on for durable state. The concrete SQLite implementation (`src/db.ts`, class
// `Store`) is an adapter behind this port and must implement `PersistenceStore`.
// No domain/application module may import the adapter or `node:sqlite` directly —
// they depend on this port only. `tests/architecture-boundary.test.mjs` locks
// that dependency direction so it cannot silently rot.

import type {
    ClusterStatus,
    EventKind,
    HypothesisStatus,
    TaskStatus,
} from "../types.js";

/** Persistence schema version. Bump on additive migrations. */
export const SCHEMA_VERSION = 4;

// ---- persisted record shapes (the persistence contract) ----

export interface PlanRow {
    id: string; goal: string; constraints: string | null;
    repo_path: string; created_at: string; status: string;
}
export interface ClusterRow {
    id: string; plan_id: string; ordinal: number; name: string; goal: string;
    tasks_json: string; acceptance_json: string; risks_json: string | null;
    model_policy_json: string; review_strategy_json: string;
    parallel_ok: number; status: ClusterStatus;
}
export interface TaskRow {
    id: string; cluster_id: string | null; codex_session_id: string | null;
    worktree: string | null; branch: string | null; repo_path: string;
    sandbox: string; model: string; effort: string; instructions: string;
    acceptance_json: string | null; max_minutes: number; network: number;
    status: TaskStatus; slice_count: number; started_at: string | null;
    ended_at: string | null; last_slice_type: string | null; last_summary: string | null;
    extra_config_json: string | null; owner_pid: number | null; codex_pid: number | null;
    target_id: string; target_kind: "local" | "ssh";
    repository_commit: string | null; worker_version: string | null;
    routing_reason: string | null; fallback_from: string | null;
    hypothesis_id: string | null;
}
export interface EventRow {
    seq: number; task_id: string; ts: string; kind: string; payload_json: string;
}
/** Identity columns of a hypothesis header, used to scope artifacts to a plan. */
export interface HypothesisHeaderRow {
    id: string; plan_id: string | null; cluster_id: string | null; task_id: string | null;
}
/** A hypothesis header row (`SELECT *` from `hypotheses`, incl. migration columns). */
export interface HypothesisRow {
    id: string; plan_id: string; text: string; status: string;
    evidence: string | null; updated_at: string;
    task_id: string | null; cluster_id: string | null; result: string | null;
    latest_version: number; created_at: string | null;
}
export interface ReviewRow {
    id: string; cluster_id: string; ts: string; status: string;
    findings_json: string | null; fixes_json: string | null; impact_json: string | null;
}
export interface CheckRow {
    id: string; cluster_id: string; cmd: string;
    exit_code: number | null; summary: string | null; ts: string;
}
export interface DecisionRow {
    id: string; plan_id: string | null; cluster_id: string | null; topic: string;
    question: string | null; decision: string; remember: number; created_at: string;
}
export interface AgentJobRow {
    id: string; task_id: string | null; cluster_id: string | null; hypothesis_id: string | null;
    model: string | null; effort: string | null; sandbox: string | null;
    status: string; started_at: string; ended_at: string | null; summary: string | null;
}
export interface HypothesisReviewRow {
    id: string; hypothesis_id: string | null; cluster_id: string | null; reviewer: string | null;
    status: string; findings_json: string | null; synthesis: string | null; created_at: string;
}
export interface ArtifactRow {
    id: string; plan_id: string | null; kind: string; path: string;
    schema_version: number | null; artifact_version: number | null;
    checksum: string | null; created_at: string;
}
export interface AuditEventRow {
    id: string; ts: string; actor: string | null; action: string;
    resource: string | null; detail_json: string | null; redacted: number;
}

/** Row for `insertHypothesisHeader` — the mutable header of a versioned hypothesis. */
export interface HypothesisHeaderInsert {
    id: string; planId: string; taskId: string | null; clusterId: string | null;
    text: string; status: string; result: string; latestVersion: number;
    createdAt: string; updatedAt: string;
}
/** Patch for `updateHypothesisHeader` — advances the header to a new version. */
export interface HypothesisHeaderUpdate {
    status: string; result: string; latestVersion: number; updatedAt: string;
    taskId: string | null; clusterId: string | null; evidenceJson: string | null;
}
/** Row for `insertHypothesisVersion` — an append-only serialized snapshot. */
export interface HypothesisVersionInsert {
    id: string; hypothesisId: string; version: number; snapshotJson: string; createdAt: string;
}

// ---- the port ----
//
// The port exposes intention-revealing methods only — no raw SQL handle. The
// concrete SQLite adapter (`src/db.ts`) owns every statement; callers depend on
// this technology-agnostic surface. `tests/architecture-boundary.test.mjs`
// forbids any consumer from reaching a raw `.db` gateway.

/** Durable state abstraction the domain/application layers depend on. */
export interface PersistenceStore {
    getSchemaVersion(): number;
    setSchemaVersion(v: number): void;
    tx<T>(fn: () => T): T;

    // plans
    createPlan(goal: string, constraints: string | null, repoPath: string): PlanRow;
    getPlan(id: string): PlanRow | undefined;

    // clusters
    upsertCluster(c: Omit<ClusterRow, "status"> & { status?: ClusterStatus }): ClusterRow;
    getCluster(id: string): ClusterRow | undefined;
    listClusters(planId: string): ClusterRow[];
    setClusterStatus(id: string, status: ClusterStatus): void;

    // tasks
    createTask(t: Omit<TaskRow,
        "slice_count" | "started_at" | "ended_at" | "last_slice_type" | "last_summary" | "codex_pid" |
        "target_id" | "target_kind" | "repository_commit" | "worker_version" | "routing_reason" | "fallback_from"
    > & Partial<Pick<TaskRow,
        "target_id" | "target_kind" | "repository_commit" | "worker_version" | "routing_reason" | "fallback_from"
    >>): TaskRow;
    getTask(id: string): TaskRow | undefined;
    listTasks(filter?: { status?: TaskStatus; clusterId?: string }): TaskRow[];
    updateTask(id: string, patch: Partial<TaskRow>): void;

    // events (append-only)
    addEvent(taskId: string, kind: EventKind, payload: unknown): EventRow;
    eventsAfter(taskId: string, cursor: number, kinds?: string[], limit?: number): EventRow[];
    maxSeq(taskId: string): number;

    // injections
    addInjection(taskId: string, message: string, priority: string): string;
    pendingInjections(taskId: string): { id: string; message: string; priority: string }[];
    markInjectionsDelivered(ids: string[]): void;

    // hypotheses
    addHypothesis(planId: string, text: string, evidence: string | null): string;
    setHypothesis(id: string, status: HypothesisStatus, evidence: string | null): void;
    listHypotheses(planId: string): HypothesisRow[];
    /** Identity columns of every hypothesis header, ordered by creation. */
    listHypothesisHeaders(): HypothesisHeaderRow[];

    // hypothesis versioning (append-only snapshots) — used by HypothesisRepo
    insertHypothesisHeader(h: HypothesisHeaderInsert): void;
    updateHypothesisHeader(id: string, h: HypothesisHeaderUpdate): void;
    insertHypothesisVersion(v: HypothesisVersionInsert): void;
    /** Serialized snapshot of a hypothesis' latest version, if any. */
    latestHypothesisSnapshot(id: string): string | undefined;
    /** Serialized snapshot of a specific version, if present. */
    hypothesisSnapshotAt(id: string, version: number): string | undefined;
    /** Every serialized snapshot of a hypothesis, ascending by version. */
    hypothesisSnapshots(id: string): string[];
    /** Hypothesis ids whose header matches a scope column, ordered by creation. */
    hypothesisIdsByColumn(column: "task_id" | "cluster_id" | "plan_id", value: string): string[];
    /** Rebind a hypothesis header to a task/cluster (provenance, no new version). */
    bindHypothesisToTask(id: string, taskId: string, clusterId: string | null): void;

    // reviews / retros / checks
    addReview(clusterId: string, status: string, findings: unknown, fixes: unknown, impact: unknown): string;
    latestReview(clusterId: string): ReviewRow | undefined;
    addRetro(clusterId: string, content: string): string;
    /** Number of retrospectives recorded for a cluster (cluster-gate predicate). */
    countRetros(clusterId: string): number;
    addCheck(clusterId: string, cmd: string, exitCode: number | null, summary: string): string;
    checksForCluster(clusterId: string): CheckRow[];

    // user_decisions
    recordDecision(d: {
        planId: string | null; clusterId: string | null; topic: string;
        question: string | null; decision: string; remember: boolean;
    }): string;
    latestDecision(clusterId: string, topic: string): DecisionRow | undefined;
    standingPreference(planId: string | null, topic: string): DecisionRow | undefined;
    listDecisions(filter?: { clusterId?: string; planId?: string }): DecisionRow[];

    // agent_jobs
    recordAgentJob(j: {
        taskId: string | null; clusterId: string | null; hypothesisId: string | null;
        model: string; effort: string; sandbox: string; status: string;
    }): string;
    finishAgentJobByTask(taskId: string, status: string, summary: string | null): void;
    listAgentJobs(filter?: { clusterId?: string; taskId?: string }): AgentJobRow[];

    // hypothesis_reviews
    addHypothesisReview(r: {
        hypothesisId: string | null; clusterId: string | null; reviewer: string;
        status: string; findings: unknown; synthesis: string | null;
    }): string;
    listHypothesisReviews(filter?: { hypothesisId?: string; clusterId?: string }): HypothesisReviewRow[];

    // artifacts
    addArtifact(a: {
        planId: string | null; kind: string; path: string;
        schemaVersion: number | null; artifactVersion: number | null; checksum: string | null;
    }): string;
    listArtifacts(planId?: string): ArtifactRow[];
    latestArtifactVersion(planId: string | null, kind: string): number;

    // audit_events
    addAuditEvent(e: {
        actor: string | null; action: string; resource: string | null;
        detail: unknown; redacted?: boolean;
    }): string;
    listAuditEvents(limit?: number): AuditEventRow[];
}
