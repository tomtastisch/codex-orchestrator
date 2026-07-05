import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ClusterStatus,
  EventKind,
  HypothesisStatus,
  TaskStatus,
} from "./types.js";
import { runMigrations } from "./db/migrations.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, constraints TEXT,
  repo_path TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
  ordinal INTEGER NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL,
  tasks_json TEXT NOT NULL, acceptance_json TEXT NOT NULL,
  risks_json TEXT, model_policy_json TEXT NOT NULL,
  review_strategy_json TEXT NOT NULL,
  parallel_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN
    ('planned','active','submitted','in_review','needs_changes',
     'blocked','confirmed','replanning','cancelled'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, cluster_id TEXT REFERENCES clusters(id),
  codex_session_id TEXT, worktree TEXT, branch TEXT, repo_path TEXT NOT NULL,
  sandbox TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  instructions TEXT NOT NULL, acceptance_json TEXT,
  max_minutes INTEGER NOT NULL, network INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','awaiting_resume','paused','blocked',
     'completed','failed','cancelled')),
  slice_count INTEGER DEFAULT 0, started_at TEXT, ended_at TEXT,
  last_slice_type TEXT, last_summary TEXT, extra_config_json TEXT,
  owner_pid INTEGER, codex_pid INTEGER,
  target_id TEXT NOT NULL DEFAULT 'local',
  target_kind TEXT NOT NULL DEFAULT 'local',
  repository_commit TEXT, worker_version TEXT, routing_reason TEXT,
  fallback_from TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
  ts TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
CREATE TABLE IF NOT EXISTS injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ts TEXT NOT NULL,
  priority TEXT NOT NULL, message TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('open','confirmed','rejected','superseded')),
  evidence TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, ts TEXT NOT NULL,
  status TEXT NOT NULL, findings_json TEXT, fixes_json TEXT, impact_json TEXT
);
CREATE TABLE IF NOT EXISTS retros (
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, ts TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, cmd TEXT NOT NULL,
  exit_code INTEGER, summary TEXT, ts TEXT NOT NULL
);
`;

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
}
export interface EventRow {
  seq: number; task_id: string; ts: string; kind: string; payload_json: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const directory = dirname(dbPath);
    mkdirSync(directory, { recursive: true });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    this.db = new DatabaseSync(dbPath);
    if (process.platform !== "win32" && existsSync(dbPath)) chmodSync(dbPath, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Schreibkonflikte gleichzeitiger Instanzen abfedern statt SQLITE_BUSY werfen.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    runMigrations(this.db);
    this.migrate();
  }

  /** Additive Migrationen für bestehende DBs (fehlende Spalten nachrüsten). */
  private migrate(): void {
    const cols = (table: string): Set<string> => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
      return new Set(rows.map((r) => r.name));
    };
    const taskCols = cols("tasks");
    if (!taskCols.has("extra_config_json")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN extra_config_json TEXT");
    }
    if (!taskCols.has("owner_pid")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN owner_pid INTEGER");
    }
    if (!taskCols.has("codex_pid")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN codex_pid INTEGER");
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- plans ----
  createPlan(goal: string, constraints: string | null, repoPath: string): PlanRow {
    const id = newId("P");
    this.db.prepare(
      "INSERT INTO plans(id,goal,constraints,repo_path,created_at,status) VALUES(?,?,?,?,?,?)"
    ).run(id, goal, constraints, repoPath, nowIso(), "active");
    return this.getPlan(id)!;
  }
  getPlan(id: string): PlanRow | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE id=?").get(id) as unknown as PlanRow | undefined;
  }

  // ---- clusters ----
  upsertCluster(c: Omit<ClusterRow, "status"> & { status?: ClusterStatus }): ClusterRow {
    const existing = this.getCluster(c.id);
    const status = existing?.status ?? c.status ?? "planned";
    if (existing) {
      this.db.prepare(
        `UPDATE clusters SET plan_id=?,ordinal=?,name=?,goal=?,tasks_json=?,
         acceptance_json=?,risks_json=?,model_policy_json=?,review_strategy_json=?,
         parallel_ok=? WHERE id=?`
      ).run(c.plan_id, c.ordinal, c.name, c.goal, c.tasks_json, c.acceptance_json,
        c.risks_json, c.model_policy_json, c.review_strategy_json, c.parallel_ok, c.id);
    } else {
      this.db.prepare(
        `INSERT INTO clusters(id,plan_id,ordinal,name,goal,tasks_json,acceptance_json,
         risks_json,model_policy_json,review_strategy_json,parallel_ok,status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(c.id, c.plan_id, c.ordinal, c.name, c.goal, c.tasks_json, c.acceptance_json,
        c.risks_json, c.model_policy_json, c.review_strategy_json, c.parallel_ok, status);
    }
    return this.getCluster(c.id)!;
  }
  getCluster(id: string): ClusterRow | undefined {
    return this.db.prepare("SELECT * FROM clusters WHERE id=?").get(id) as unknown as ClusterRow | undefined;
  }
  listClusters(planId: string): ClusterRow[] {
    return this.db.prepare("SELECT * FROM clusters WHERE plan_id=? ORDER BY ordinal")
      .all(planId) as unknown as ClusterRow[];
  }
  setClusterStatus(id: string, status: ClusterStatus): void {
    this.db.prepare("UPDATE clusters SET status=? WHERE id=?").run(status, id);
  }

  // ---- tasks ----
  createTask(t: Omit<TaskRow,
    "slice_count" | "started_at" | "ended_at" | "last_slice_type" | "last_summary" | "codex_pid" |
    "target_id" | "target_kind" | "repository_commit" | "worker_version" | "routing_reason" | "fallback_from"
  > & Partial<Pick<TaskRow,
    "target_id" | "target_kind" | "repository_commit" | "worker_version" | "routing_reason" | "fallback_from"
  >>): TaskRow {
    this.db.prepare(
      `INSERT INTO tasks(id,cluster_id,codex_session_id,worktree,branch,repo_path,
        sandbox,model,effort,instructions,acceptance_json,max_minutes,network,status,slice_count,extra_config_json,
        target_id,target_kind,repository_commit,worker_version,routing_reason,fallback_from)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`
    ).run(t.id, t.cluster_id, t.codex_session_id, t.worktree, t.branch, t.repo_path,
      t.sandbox, t.model, t.effort, t.instructions, t.acceptance_json, t.max_minutes,
      t.network, t.status, t.extra_config_json ?? null,
      t.target_id ?? "local", t.target_kind ?? "local", t.repository_commit ?? null,
      t.worker_version ?? null, t.routing_reason ?? "local-default", t.fallback_from ?? null);
    return this.getTask(t.id)!;
  }
  getTask(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as unknown as TaskRow | undefined;
  }
  listTasks(filter?: { status?: TaskStatus; clusterId?: string }): TaskRow[] {
    if (filter?.clusterId) {
      return this.db.prepare("SELECT * FROM tasks WHERE cluster_id=? ORDER BY started_at")
        .all(filter.clusterId) as unknown as TaskRow[];
    }
    if (filter?.status) {
      return this.db.prepare("SELECT * FROM tasks WHERE status=?").all(filter.status) as unknown as TaskRow[];
    }
    return this.db.prepare("SELECT * FROM tasks ORDER BY started_at DESC").all() as unknown as TaskRow[];
  }
  updateTask(id: string, patch: Partial<TaskRow>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k}=?`).join(",");
    const vals = keys.map((k) => (patch as any)[k]);
    this.db.prepare(`UPDATE tasks SET ${set} WHERE id=?`).run(...vals, id);
  }

  // ---- events (append-only) ----
  addEvent(taskId: string, kind: EventKind, payload: unknown): EventRow {
    const info = this.db.prepare(
      "INSERT INTO events(task_id,ts,kind,payload_json) VALUES(?,?,?,?)"
    ).run(taskId, nowIso(), kind, JSON.stringify(payload ?? {}));
    const seq = Number(info.lastInsertRowid);
    return { seq, task_id: taskId, ts: nowIso(), kind, payload_json: JSON.stringify(payload ?? {}) };
  }
  eventsAfter(taskId: string, cursor: number, kinds?: string[], limit = 200): EventRow[] {
    let rows: EventRow[];
    if (kinds && kinds.length) {
      const placeholders = kinds.map(() => "?").join(",");
      rows = this.db.prepare(
        `SELECT * FROM events WHERE task_id=? AND seq>? AND kind IN (${placeholders})
         ORDER BY seq LIMIT ?`
      ).all(taskId, cursor, ...kinds, limit) as unknown as EventRow[];
    } else {
      rows = this.db.prepare(
        "SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?"
      ).all(taskId, cursor, limit) as unknown as EventRow[];
    }
    return rows;
  }
  maxSeq(taskId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM events WHERE task_id=?")
      .get(taskId) as unknown as { m: number | null };
    return r?.m ?? 0;
  }

  // ---- injections ----
  addInjection(taskId: string, message: string, priority: string): string {
    const id = newId("I");
    this.db.prepare(
      "INSERT INTO injections(id,task_id,ts,priority,message,delivered_at) VALUES(?,?,?,?,?,NULL)"
    ).run(id, taskId, nowIso(), priority, message);
    return id;
  }
  pendingInjections(taskId: string): { id: string; message: string; priority: string }[] {
    return this.db.prepare(
      "SELECT id,message,priority FROM injections WHERE task_id=? AND delivered_at IS NULL ORDER BY ts"
    ).all(taskId) as unknown as { id: string; message: string; priority: string }[];
  }
  markInjectionsDelivered(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE injections SET delivered_at=? WHERE id=?");
    for (const id of ids) stmt.run(nowIso(), id);
  }

  // ---- hypotheses ----
  addHypothesis(planId: string, text: string, evidence: string | null): string {
    const id = newId("H");
    this.db.prepare(
      "INSERT INTO hypotheses(id,plan_id,text,status,evidence,updated_at) VALUES(?,?,?,?,?,?)"
    ).run(id, planId, text, "open", evidence, nowIso());
    return id;
  }
  setHypothesis(id: string, status: HypothesisStatus, evidence: string | null): void {
    this.db.prepare("UPDATE hypotheses SET status=?, evidence=COALESCE(?,evidence), updated_at=? WHERE id=?")
      .run(status, evidence, nowIso(), id);
  }
  listHypotheses(planId: string): any[] {
    return this.db.prepare("SELECT * FROM hypotheses WHERE plan_id=? ORDER BY updated_at").all(planId);
  }

  // ---- reviews / retros / checks ----
  addReview(clusterId: string, status: string, findings: unknown, fixes: unknown, impact: unknown): string {
    const id = newId("R");
    this.db.prepare(
      "INSERT INTO reviews(id,cluster_id,ts,status,findings_json,fixes_json,impact_json) VALUES(?,?,?,?,?,?,?)"
    ).run(id, clusterId, nowIso(), status, JSON.stringify(findings ?? null),
      JSON.stringify(fixes ?? null), JSON.stringify(impact ?? null));
    return id;
  }
  latestReview(clusterId: string): any | undefined {
    return this.db.prepare("SELECT * FROM reviews WHERE cluster_id=? ORDER BY ts DESC LIMIT 1").get(clusterId);
  }
  addRetro(clusterId: string, content: string): string {
    const id = newId("RT");
    this.db.prepare("INSERT INTO retros(id,cluster_id,ts,content) VALUES(?,?,?,?)")
      .run(id, clusterId, nowIso(), content);
    return id;
  }
  addCheck(clusterId: string, cmd: string, exitCode: number | null, summary: string): string {
    const id = newId("CK");
    this.db.prepare(
      "INSERT INTO checks(id,cluster_id,cmd,exit_code,summary,ts) VALUES(?,?,?,?,?,?)"
    ).run(id, clusterId, cmd, exitCode, summary, nowIso());
    return id;
  }
  checksForCluster(clusterId: string): any[] {
    return this.db.prepare("SELECT * FROM checks WHERE cluster_id=? ORDER BY ts").all(clusterId);
  }
}
