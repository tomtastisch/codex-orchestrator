import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ClusterStateMachine } from "../dist/statemachine.js";
import { createSystemStore } from "./helpers/system-deps.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "orch-test-"));
  return createSystemStore(join(dir, "s.sqlite"));
}

function seedCluster(store, planId, id, ordinal, checks = [], parallel = 0) {
  return store.upsertCluster({
    id, plan_id: planId, ordinal, name: id, goal: "g",
    tasks_json: "[]", acceptance_json: "[]", risks_json: "[]",
    model_policy_json: "{}",
    review_strategy_json: JSON.stringify({ checks }),
    parallel_ok: parallel,
  });
}

test("confirm wird ohne REVIEW_RESULT verweigert", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  const m = new ClusterStateMachine(store);
  assert.equal(m.transition("C1", "start").status, "active");
  assert.equal(m.transition("C1", "submit").status, "submitted");
  m.transition("C1", "review", { status: "needs_changes" }); // review vorhanden, aber nicht confirmed
  const r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.reasons), /nicht 'confirmed'/);
});

test("confirm verlangt grüne deklarierte Checks", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0, ["npm_test"]);
  const m = new ClusterStateMachine(store);
  m.transition("C1", "start");
  m.transition("C1", "submit");
  m.transition("C1", "review", { status: "confirmed" });
  // Kein Check-Ergebnis vorhanden -> confirm verweigert
  let r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.reasons), /nicht ausgeführt/);
  // Roter Check -> weiterhin verweigert
  store.addCheck("C1", "npm_test", 1, "fail");
  r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.reasons), /nicht grün/);
  // Grüner Check -> confirm erlaubt
  store.addCheck("C1", "npm_test", 0, "pass");
  r = m.transition("C1", "confirm");
  assert.equal(r.ok, true);
  assert.equal(r.status, "confirmed");
});

test("start von C2 blockiert bis C1 confirmed UND Retro vorliegt", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  seedCluster(store, plan.id, "C2", 1);
  const m = new ClusterStateMachine(store);
  // C2 darf nicht starten, solange C1 nicht confirmed
  let r = m.transition("C2", "start");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.blocking), /C1 ist planned/);
  // C1 confirmen
  m.transition("C1", "start");
  m.transition("C1", "submit");
  m.transition("C1", "review", { status: "confirmed" });
  m.transition("C1", "confirm");
  // Retro fehlt noch
  r = m.transition("C2", "start");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.blocking), /Retrospektive fehlt/);
  // Retro nachziehen
  const retro = m.transition("C1", "retro", { content: "gelernt: X", hypotheses: [] });
  assert.equal(retro.ok, true);
  r = m.transition("C2", "start");
  assert.equal(r.ok, true);
  assert.equal(r.status, "active");
});

test("parallel_ok umgeht Vorgänger-Gate", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  seedCluster(store, plan.id, "C2", 1, [], 1);
  const m = new ClusterStateMachine(store);
  const r = m.transition("C2", "start");
  assert.equal(r.ok, true);
});

test("retro aktualisiert Hypothesenstatus in einer Transaktion", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  const hid = store.addHypothesis(plan.id, "Annahme A", null);
  const m = new ClusterStateMachine(store);
  m.transition("C1", "start");
  m.transition("C1", "submit");
  m.transition("C1", "review", { status: "confirmed" });
  m.transition("C1", "confirm");
  m.transition("C1", "retro", { content: "done", hypotheses: [{ id: hid, status: "confirmed", evidence: "Test grün" }] });
  const h = store.listHypotheses(plan.id).find((x) => x.id === hid);
  assert.equal(h.status, "confirmed");
  assert.match(h.evidence, /Test grün/);
});

test("ungültiger Übergang wird abgelehnt", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  const m = new ClusterStateMachine(store);
  const r = m.transition("C1", "confirm"); // aus 'planned' nicht erlaubt
  assert.equal(r.ok, false);
  assert.match(r.error, /nicht erlaubt/);
});

test("review lehnt unbekannte Reviewstatus ab", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/repo");
  seedCluster(store, plan.id, "C1", 0);
  const m = new ClusterStateMachine(store);
  m.transition("C1", "start");
  m.transition("C1", "submit");

  const r = m.transition("C1", "review", { status: "looks-good-ish" });

  assert.equal(r.ok, false);
  assert.match(r.error, /Review-Status/);
  assert.equal(store.latestReview("C1"), undefined);
});
