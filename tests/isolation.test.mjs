import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../dist/session.js";
import { Store } from "../dist/db.js";
import { SessionManager } from "../dist/session.js";
import { createSystemSessionManager, createSystemStore } from "./helpers/system-deps.mjs";

function freshMgr() {
  const dir = mkdtempSync(join(tmpdir(), "orch-iso-"));
  const store = createSystemStore(join(dir, "s.sqlite"));
  return { store, mgr: createSystemSessionManager(store) };
}

function makeRunningTask(store, ownerPid) {
  const t = store.createTask({
    id: "T_" + Math.random().toString(36).slice(2, 8),
    cluster_id: null, codex_session_id: null, worktree: null, branch: null,
    repo_path: "/tmp/r", sandbox: "read-only", model: "gpt-5.5", effort: "low",
    instructions: "x", acceptance_json: "[]", max_minutes: 5, network: 0, status: "queued",
    extra_config_json: null, owner_pid: null,
  });
  store.updateTask(t.id, { status: "running", owner_pid: ownerPid });
  return t.id;
}

test("isProcessAlive: eigener Prozess lebt, Fantasie-PID nicht", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2147480000), false);
});

test("Reaper killt tote/legacy Tasks, verschont lebende Nachbar-Instanz", () => {
  const { store, mgr } = freshMgr();
  const deadTask = makeRunningTask(store, 2147480000); // toter Prozess
  const legacyTask = makeRunningTask(store, null);      // ohne owner_pid (alt)
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
  try {
    const siblingTask = makeRunningTask(store, sibling.pid);
    const n = mgr.reapOnStartup();

    assert.equal(store.getTask(deadTask).status, "failed", "toter Task -> failed");
    assert.equal(store.getTask(legacyTask).status, "failed", "legacy Task -> failed");
    assert.equal(store.getTask(siblingTask).status, "running", "lebender Nachbar bleibt running");
    assert.equal(n, 2);
  } finally {
    sibling.kill();
  }
});

test("Reaper terminalisiert offene agent jobs für verwaiste aktive Tasks", () => {
  const fixed = "2026-07-11T16:30:00.000Z";
  const clock = { now: () => fixed };
  let sequence = 0;
  const ids = { newId: (prefix) => `${prefix}_reaper_${++sequence}` };
  const dir = mkdtempSync(join(tmpdir(), "orch-reaper-job-"));
  const store = new Store(join(dir, "s.sqlite"), clock, ids);
  const target = { id: "fake", kind: "local" };
  const mgr = new SessionManager(store, () => target, ids, clock);
  const taskIds = [];

  for (const status of ["running", "awaiting_resume"]) {
    const taskId = makeRunningTask(store, 2147480000);
    store.updateTask(taskId, { status });
    store.recordAgentJob({
      taskId,
      clusterId: null,
      hypothesisId: null,
      model: "auto",
      effort: "low",
      sandbox: "read-only",
      status,
    });
    taskIds.push(taskId);
  }

  assert.equal(mgr.reapOnStartup(), 2);

  for (const taskId of taskIds) {
    const task = store.getTask(taskId);
    assert.equal(task.status, "failed");
    assert.equal(task.ended_at, fixed);

    const job = store.listAgentJobs({ taskId }).at(-1);
    assert.equal(job.status, "failed");
    assert.equal(job.ended_at, fixed);

    const statusEvent = store.eventsAfter(taskId, 0).find((event) => event.kind === "task_status");
    const payload = JSON.parse(statusEvent.payload_json);
    assert.match(payload.reason, /^Reaper: verwaister Prozess/);
    assert.equal(job.summary, payload.reason);
  }
});

test("verschiedene Stores mischen keine Daten", () => {
  const a = freshMgr();
  const b = freshMgr();
  const pa = a.store.createPlan("Projekt A", null, "/repoA");
  const pb = b.store.createPlan("Projekt B", null, "/repoB");
  // Store A kennt nur Plan A, Store B nur Plan B.
  assert.ok(a.store.getPlan(pa.id));
  assert.equal(a.store.getPlan(pb.id), undefined);
  assert.ok(b.store.getPlan(pb.id));
  assert.equal(b.store.getPlan(pa.id), undefined);
});
