import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ClusterStatus,
  EventKind,
  HypothesisStatus,
  TaskStatus,
} from "./types.js";
import { runMigrations } from "./db/migrations.js";
import { redactDeep, redactText } from "./redact.js";
import { newId, nowIso } from "./system-clock.js";
import {
  SCHEMA_VERSION,
  type ClusterRow,
  type EventRow,
  type PersistenceStore,
  type PlanRow,
  type TaskRow,
} from "./ports/persistence.js";

// Row shapes and SCHEMA_VERSION now live with the persistence port so consumers
// depend on the port, not the SQLite adapter. Re-exported here for the store's
// own tests, which construct the adapter directly.
export { SCHEMA_VERSION };
export type { ClusterRow, EventRow, PlanRow, TaskRow };

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
  fallback_from TEXT, hypothesis_id TEXT
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
CREATE TABLE IF NOT EXISTS hypothesis_versions (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(hypothesis_id, version)
);
CREATE INDEX IF NOT EXISTS idx_hyp_versions ON hypothesis_versions(hypothesis_id, version);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_decisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  cluster_id TEXT,
  topic TEXT NOT NULL,
  question TEXT,
  decision TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions ON user_decisions(topic, cluster_id, created_at);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY, task_id TEXT, cluster_id TEXT, hypothesis_id TEXT,
  model TEXT, effort TEXT, sandbox TEXT, status TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_task ON agent_jobs(task_id);
CREATE TABLE IF NOT EXISTS hypothesis_reviews (
  id TEXT PRIMARY KEY, hypothesis_id TEXT, cluster_id TEXT,
  reviewer TEXT, status TEXT NOT NULL, findings_json TEXT, synthesis TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, plan_id TEXT, kind TEXT NOT NULL, path TEXT NOT NULL,
  schema_version INTEGER, artifact_version INTEGER, checksum TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
  resource TEXT, detail_json TEXT, redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
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

export class Store implements PersistenceStore {
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
    this.runMigrations();
  }

  private columns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  private ensureColumn(table: string, col: string, ddl: string): void {
    if (!this.columns(table).has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  /**
   * Geordneter, transaktionaler Migrations-Runner (Cluster 5). Jede Migration
   * hat eine Zielversion und läuft nur, wenn die aktuelle schema_version kleiner
   * ist. Die `up`-Schritte sind idempotent (Spalten-/Tabellen-Existenzprüfung),
   * damit Bestands-DBs beliebiger Version sicher aufsteigen. Tabellen werden vom
   * Basis-SCHEMA (CREATE IF NOT EXISTS) angelegt; Migrationen ergänzen Spalten
   * und schreiben die Versionsmarke fort — beides in einer Transaktion.
   */
  private runMigrations(): void {
    const migrations: { version: number; up: () => void }[] = [
      { version: 2, up: () => {
        // Cluster 1: reiches, versioniertes Hypothesenmodell (Header-Spalten).
        this.ensureColumn("hypotheses", "task_id", "task_id TEXT");
        this.ensureColumn("hypotheses", "cluster_id", "cluster_id TEXT");
        this.ensureColumn("hypotheses", "result", "result TEXT");
        this.ensureColumn("hypotheses", "latest_version", "latest_version INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn("hypotheses", "created_at", "created_at TEXT");
      } },
      { version: 3, up: () => {
        // Frühere additive Task-Spalten + Cluster-2-Link + user_decisions (Tabelle via SCHEMA).
        this.ensureColumn("tasks", "extra_config_json", "extra_config_json TEXT");
        this.ensureColumn("tasks", "owner_pid", "owner_pid INTEGER");
        this.ensureColumn("tasks", "codex_pid", "codex_pid INTEGER");
        this.ensureColumn("tasks", "hypothesis_id", "hypothesis_id TEXT");
      } },
      { version: 4, up: () => {
        // Cluster 5: agent_jobs, hypothesis_reviews, artifacts, audit_events (Tabellen via SCHEMA).
      } },
    ];
    let current = this.getSchemaVersion();
    for (const m of migrations) {
      if (current < m.version) {
        this.tx(() => {
          m.up();
          this.setSchemaVersion(m.version);
        });
        current = m.version;
      }
    }
  }

  /** Aktuelle Schema-Version (0, wenn noch nie gesetzt). */
  getSchemaVersion(): number {
    try {
      const r = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        | { value: string }
        | undefined;
      return r ? Number(r.value) : 0;
    } catch {
      return 0;
    }
  }

  setSchemaVersion(v: number): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=?")
      .run(String(v), String(v));
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
        hypothesis_id,target_id,target_kind,repository_commit,worker_version,routing_reason,fallback_from)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`
    ).run(t.id, t.cluster_id, t.codex_session_id, t.worktree, t.branch, t.repo_path,
      t.sandbox, t.model, t.effort, t.instructions, t.acceptance_json, t.max_minutes,
      t.network, t.status, t.extra_config_json ?? null, t.hypothesis_id ?? null,
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

  // ---- user_decisions (Cluster 4: Nachkontrolle-Gate + Präferenzen) ----
  recordDecision(d: {
    planId: string | null; clusterId: string | null; topic: string;
    question: string | null; decision: string; remember: boolean;
  }): string {
    const id = newId("UD");
    this.db.prepare(
      "INSERT INTO user_decisions(id,plan_id,cluster_id,topic,question,decision,remember,created_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run(id, d.planId, d.clusterId, d.topic, d.question, d.decision, d.remember ? 1 : 0, nowIso());
    return id;
  }
  /** Neueste Entscheidung zu einem Thema für einen Cluster. */
  latestDecision(clusterId: string, topic: string): any | undefined {
    return this.db.prepare(
      "SELECT * FROM user_decisions WHERE cluster_id=? AND topic=? ORDER BY created_at DESC LIMIT 1"
    ).get(clusterId, topic);
  }
  /** Stehende Präferenz (remember=1) für einen Plan/ein Thema — plan-weit gültig. */
  standingPreference(planId: string | null, topic: string): any | undefined {
    return this.db.prepare(
      "SELECT * FROM user_decisions WHERE topic=? AND remember=1 AND (plan_id IS ? OR plan_id=?) ORDER BY created_at DESC LIMIT 1"
    ).get(topic, planId, planId);
  }
  listDecisions(filter?: { clusterId?: string; planId?: string }): any[] {
    if (filter?.clusterId) {
      return this.db.prepare("SELECT * FROM user_decisions WHERE cluster_id=? ORDER BY created_at").all(filter.clusterId);
    }
    if (filter?.planId) {
      return this.db.prepare("SELECT * FROM user_decisions WHERE plan_id=? ORDER BY created_at").all(filter.planId);
    }
    return this.db.prepare("SELECT * FROM user_decisions ORDER BY created_at").all();
  }

  // ---- agent_jobs (Cluster 5: auditierbare Codex-Job-Historie) ----
  recordAgentJob(j: {
    taskId: string | null; clusterId: string | null; hypothesisId: string | null;
    model: string; effort: string; sandbox: string; status: string;
  }): string {
    const id = newId("AJ");
    this.db.prepare(
      `INSERT INTO agent_jobs(id,task_id,cluster_id,hypothesis_id,model,effort,sandbox,status,started_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(id, j.taskId, j.clusterId, j.hypothesisId, j.model, j.effort, j.sandbox, j.status, nowIso());
    return id;
  }
  /** Schließt den letzten offenen Job eines Tasks ab (Status + Zusammenfassung). */
  finishAgentJobByTask(taskId: string, status: string, summary: string | null): void {
    const row = this.db.prepare(
      "SELECT id FROM agent_jobs WHERE task_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    ).get(taskId) as { id: string } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE agent_jobs SET status=?, summary=COALESCE(?,summary), ended_at=? WHERE id=?")
      .run(status, summary, nowIso(), row.id);
  }
  listAgentJobs(filter?: { clusterId?: string; taskId?: string }): any[] {
    if (filter?.taskId) return this.db.prepare("SELECT * FROM agent_jobs WHERE task_id=? ORDER BY started_at").all(filter.taskId);
    if (filter?.clusterId) return this.db.prepare("SELECT * FROM agent_jobs WHERE cluster_id=? ORDER BY started_at").all(filter.clusterId);
    return this.db.prepare("SELECT * FROM agent_jobs ORDER BY started_at").all();
  }

  // ---- hypothesis_reviews (Cluster 5: lokale Nachkontrolle je Hypothese) ----
  addHypothesisReview(r: {
    hypothesisId: string | null; clusterId: string | null; reviewer: string;
    status: string; findings: unknown; synthesis: string | null;
  }): string {
    const id = newId("HR");
    this.db.prepare(
      `INSERT INTO hypothesis_reviews(id,hypothesis_id,cluster_id,reviewer,status,findings_json,synthesis,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(id, r.hypothesisId, r.clusterId, r.reviewer, r.status,
      JSON.stringify(r.findings ?? null), r.synthesis, nowIso());
    return id;
  }
  listHypothesisReviews(filter?: { hypothesisId?: string; clusterId?: string }): any[] {
    if (filter?.hypothesisId) return this.db.prepare("SELECT * FROM hypothesis_reviews WHERE hypothesis_id=? ORDER BY created_at").all(filter.hypothesisId);
    if (filter?.clusterId) return this.db.prepare("SELECT * FROM hypothesis_reviews WHERE cluster_id=? ORDER BY created_at").all(filter.clusterId);
    return this.db.prepare("SELECT * FROM hypothesis_reviews ORDER BY created_at").all();
  }

  // ---- artifacts (Cluster 5/6: versionierte Ergebnisartefakte) ----
  addArtifact(a: {
    planId: string | null; kind: string; path: string;
    schemaVersion: number | null; artifactVersion: number | null; checksum: string | null;
  }): string {
    const id = newId("AF");
    this.db.prepare(
      `INSERT INTO artifacts(id,plan_id,kind,path,schema_version,artifact_version,checksum,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(id, a.planId, a.kind, a.path, a.schemaVersion, a.artifactVersion, a.checksum, nowIso());
    return id;
  }
  listArtifacts(planId?: string): any[] {
    if (planId) return this.db.prepare("SELECT * FROM artifacts WHERE plan_id=? ORDER BY created_at").all(planId);
    return this.db.prepare("SELECT * FROM artifacts ORDER BY created_at").all();
  }
  latestArtifactVersion(planId: string | null, kind: string): number {
    const r = this.db.prepare(
      "SELECT MAX(artifact_version) AS m FROM artifacts WHERE (plan_id IS ? OR plan_id=?) AND kind=?"
    ).get(planId, planId, kind) as { m: number | null };
    return r?.m ?? 0;
  }

  // ---- audit_events (Cluster 5/7: sicherheitsrelevanter Audit-Trail) ----
  addAuditEvent(e: {
    actor: string | null; action: string; resource: string | null;
    detail: unknown; redacted?: boolean;
  }): string {
    const id = newId("AU");
    // Cluster 7: Detail immer durch die Redaction schicken — nie ungescrubbte Secrets im Audit-Log.
    const safeDetail = redactDeep(e.detail ?? null);
    this.db.prepare(
      `INSERT INTO audit_events(id,ts,actor,action,resource,detail_json,redacted)
       VALUES(?,?,?,?,?,?,?)`
    ).run(id, nowIso(), e.actor, e.action, redactText(e.resource ?? "") || null,
      JSON.stringify(safeDetail), 1);
    return id;
  }
  listAuditEvents(limit = 500): any[] {
    return this.db.prepare("SELECT * FROM audit_events ORDER BY ts DESC LIMIT ?").all(limit);
  }
}
