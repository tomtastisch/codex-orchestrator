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

// ---- SQL gateway ----
//
// A minimal, technology-agnostic prepared-statement surface. It exists so the
// handful of callers that still issue their own statements do so through the
// port rather than importing `node:sqlite`. It is structurally satisfied by
// node:sqlite's DatabaseSync/StatementSync, so the SQLite adapter exposes its
// raw handle without a wrapper.

export interface SqlStatement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}
export interface SqlDatabase {
    prepare(sql: string): SqlStatement;
    exec(sql: string): void;
}

// ---- the port ----

/** Durable state abstraction the domain/application layers depend on. */
export interface PersistenceStore {
    /** Raw SQL gateway for callers that still own their statements. */
    readonly db: SqlDatabase;

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
    listHypotheses(planId: string): any[];

    // reviews / retros / checks
    addReview(clusterId: string, status: string, findings: unknown, fixes: unknown, impact: unknown): string;
    latestReview(clusterId: string): any | undefined;
    addRetro(clusterId: string, content: string): string;
    addCheck(clusterId: string, cmd: string, exitCode: number | null, summary: string): string;
    checksForCluster(clusterId: string): any[];

    // user_decisions
    recordDecision(d: {
        planId: string | null; clusterId: string | null; topic: string;
        question: string | null; decision: string; remember: boolean;
    }): string;
    latestDecision(clusterId: string, topic: string): any | undefined;
    standingPreference(planId: string | null, topic: string): any | undefined;
    listDecisions(filter?: { clusterId?: string; planId?: string }): any[];

    // agent_jobs
    recordAgentJob(j: {
        taskId: string | null; clusterId: string | null; hypothesisId: string | null;
        model: string; effort: string; sandbox: string; status: string;
    }): string;
    finishAgentJobByTask(taskId: string, status: string, summary: string | null): void;
    listAgentJobs(filter?: { clusterId?: string; taskId?: string }): any[];

    // hypothesis_reviews
    addHypothesisReview(r: {
        hypothesisId: string | null; clusterId: string | null; reviewer: string;
        status: string; findings: unknown; synthesis: string | null;
    }): string;
    listHypothesisReviews(filter?: { hypothesisId?: string; clusterId?: string }): any[];

    // artifacts
    addArtifact(a: {
        planId: string | null; kind: string; path: string;
        schemaVersion: number | null; artifactVersion: number | null; checksum: string | null;
    }): string;
    listArtifacts(planId?: string): any[];
    latestArtifactVersion(planId: string | null, kind: string): number;

    // audit_events
    addAuditEvent(e: {
        actor: string | null; action: string; resource: string | null;
        detail: unknown; redacted?: boolean;
    }): string;
    listAuditEvents(limit?: number): any[];
}
