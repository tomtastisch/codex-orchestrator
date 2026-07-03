import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { ClusterStateMachine } from "../dist/statemachine.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "orch-cg-"));
  return new Store(join(dir, "s.sqlite"));
}
function seed(store, planId, id, ordinal = 0, checks = []) {
  return store.upsertCluster({
    id, plan_id: planId, ordinal, name: id, goal: "g",
    tasks_json: "[]", acceptance_json: "[]", risks_json: "[]",
    model_policy_json: "{}", review_strategy_json: JSON.stringify({ checks }), parallel_ok: 0,
  });
}
function toActiveReview(m, store, id, status, findings) {
  m.transition(id, "start");
  m.transition(id, "submit");
  // Review direkt persistieren (mit Findings), Status setzen.
  store.addReview(id, status, findings ?? null, null, null);
  store.setClusterStatus(id, "in_review");
}

test("Abschluss ohne Findings gelingt (Review confirmed)", () => {
  const store = fresh();
  const plan = store.createPlan("g", null, "/tmp/r");
  seed(store, plan.id, "C1");
  const m = new ClusterStateMachine(store);
  toActiveReview(m, store, "C1", "confirmed", []);
  const r = m.transition("C1", "confirm");
  assert.equal(r.ok, true);
  assert.equal(r.status, "confirmed");
});

test("Findings blockieren Abschluss bis zur Nutzerentscheidung", () => {
  const store = fresh();
  const plan = store.createPlan("g", null, "/tmp/r");
  seed(store, plan.id, "C1");
  const m = new ClusterStateMachine(store);
  // Review 'confirmed', aber mit Auffälligkeiten -> confirm blockiert.
  toActiveReview(m, store, "C1", "confirmed", ["Randfall X ungetestet"]);
  let r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.reasons), /Auffälligkeit/);

  // Nutzer entscheidet 'accept' -> confirm gelingt.
  store.recordDecision({ planId: plan.id, clusterId: "C1", topic: "cluster_findings", question: "Nachbessern?", decision: "accept", remember: false });
  r = m.transition("C1", "confirm");
  assert.equal(r.ok, true);
  assert.equal(r.status, "confirmed");
});

test("Entscheidung 'fix' gibt NICHT frei", () => {
  const store = fresh();
  const plan = store.createPlan("g", null, "/tmp/r");
  seed(store, plan.id, "C1");
  const m = new ClusterStateMachine(store);
  toActiveReview(m, store, "C1", "confirmed", ["Bug Y"]);
  store.recordDecision({ planId: plan.id, clusterId: "C1", topic: "cluster_findings", question: "Nachbessern?", decision: "fix", remember: false });
  const r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.details.reasons), /Auffälligkeit/);
});

test("stehende Präferenz (remember) gilt plan-weit für Folge-Cluster", () => {
  const store = fresh();
  const plan = store.createPlan("g", null, "/tmp/r");
  seed(store, plan.id, "C1", 0);
  const m = new ClusterStateMachine(store);
  // Nutzer setzt einmal 'accept' als stehende Präferenz.
  store.recordDecision({ planId: plan.id, clusterId: null, topic: "cluster_findings", question: "Immer akzeptieren?", decision: "accept", remember: true });
  toActiveReview(m, store, "C1", "confirmed", ["kosmetische Anmerkung"]);
  const r = m.transition("C1", "confirm");
  assert.equal(r.ok, true, JSON.stringify(r.details?.reasons));
});

test("preference-Lookup liefert die gemerkte Entscheidung", () => {
  const store = fresh();
  const plan = store.createPlan("g", null, "/tmp/r");
  store.recordDecision({ planId: plan.id, clusterId: null, topic: "cluster_findings", question: "?", decision: "always_ask", remember: true });
  const pref = store.standingPreference(plan.id, "cluster_findings");
  assert.equal(pref.decision, "always_ask");
  // 'always_ask' gibt Findings NICHT frei.
  seed(store, plan.id, "C1");
  const m = new ClusterStateMachine(store);
  toActiveReview(m, store, "C1", "confirmed", ["etwas"]);
  const r = m.transition("C1", "confirm");
  assert.equal(r.ok, false);
});
