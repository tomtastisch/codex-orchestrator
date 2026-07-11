import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../dist/db.js";
import { createSystemStore } from "./helpers/system-deps.mjs";

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), "orch-persist-")), "s.sqlite");
}

test("Migrations-Runner setzt schema_version auf den neuesten Stand", () => {
  const store = createSystemStore(freshPath());
  assert.equal(store.getSchemaVersion(), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 4);
});

test("erneutes Öffnen derselben DB ist idempotent (keine Doppel-Migration)", () => {
  const path = freshPath();
  const s1 = createSystemStore(path);
  s1.recordAgentJob({ taskId: "T1", clusterId: "C1", hypothesisId: "H1", model: "m", effort: "low", sandbox: "read-only", status: "queued" });
  const v1 = s1.getSchemaVersion();
  // Zweite Instanz auf derselben Datei -> darf nicht erneut migrieren/werfen.
  const s2 = createSystemStore(path);
  assert.equal(s2.getSchemaVersion(), v1);
  assert.equal(s2.listAgentJobs().length, 1);
});

test("alle Cluster-5-Tabellen existieren", () => {
  const store = createSystemStore(freshPath());
  const names = new Set(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  for (const t of ["agent_jobs", "hypothesis_reviews", "artifacts", "audit_events", "user_decisions", "hypothesis_versions", "meta"]) {
    assert.ok(names.has(t), `Tabelle fehlt: ${t}`);
  }
});

test("agent_jobs: aufzeichnen und per Task abschließen", () => {
  const store = createSystemStore(freshPath());
  store.recordAgentJob({ taskId: "T7", clusterId: "C1", hypothesisId: "H1", model: "gpt-5.5", effort: "high", sandbox: "workspace-write", status: "queued" });
  let jobs = store.listAgentJobs({ taskId: "T7" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ended_at, null);
  store.finishAgentJobByTask("T7", "completed", "submission ok");
  jobs = store.listAgentJobs({ taskId: "T7" });
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].summary, "submission ok");
  assert.ok(jobs[0].ended_at);
});

test("hypothesis_reviews: lokale Nachkontrolle persistieren", () => {
  const store = createSystemStore(freshPath());
  store.addHypothesisReview({ hypothesisId: "H1", clusterId: "C1", reviewer: "codex:read-only", status: "confirmed", findings: [], synthesis: "keine Auffälligkeiten" });
  const rows = store.listHypothesisReviews({ hypothesisId: "H1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "confirmed");
});

test("artifacts: Version hochzählen", () => {
  const store = createSystemStore(freshPath());
  assert.equal(store.latestArtifactVersion("P1", "toln"), 0);
  store.addArtifact({ planId: "P1", kind: "toln", path: "/x/a.v1.toln", schemaVersion: 1, artifactVersion: 1, checksum: "abc" });
  store.addArtifact({ planId: "P1", kind: "toln", path: "/x/a.v2.toln", schemaVersion: 1, artifactVersion: 2, checksum: "def" });
  assert.equal(store.latestArtifactVersion("P1", "toln"), 2);
  assert.equal(store.listArtifacts("P1").length, 2);
});

test("audit_events: append + neueste zuerst", () => {
  const store = createSystemStore(freshPath());
  store.addAuditEvent({ actor: "claude", action: "sandbox_selected", resource: "task", detail: { sandbox: "read-only" }, redacted: false });
  store.addAuditEvent({ actor: "claude", action: "danger_mode_denied", resource: "task", detail: { requested: "danger-full-access" }, redacted: false });
  const evs = store.listAuditEvents();
  assert.equal(evs.length, 2);
  assert.equal(evs[0].action, "danger_mode_denied"); // DESC
});

test("Transaktion: fehlgeschlagener Block rollt zurück", () => {
  const store = createSystemStore(freshPath());
  assert.throws(() => store.tx(() => {
    store.addAuditEvent({ actor: "a", action: "x", resource: null, detail: null, redacted: false });
    throw new Error("boom");
  }), /boom/);
  assert.equal(store.listAuditEvents().length, 0);
});
