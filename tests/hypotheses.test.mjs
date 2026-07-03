import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../dist/db.js";
import { HypothesisRepo } from "../dist/hypotheses.js";

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), "orch-hyp-"));
  const store = new Store(join(dir, "s.sqlite"));
  return { store, repo: new HypothesisRepo(store) };
}

test("schema_version wird beim Öffnen gesetzt", () => {
  const { store } = freshRepo();
  assert.equal(store.getSchemaVersion(), SCHEMA_VERSION);
});

test("Erstellung: Version 1 mit allen Pflichtfeldern", () => {
  const { repo } = freshRepo();
  const h = repo.create({
    taskId: "T_1",
    clusterId: "C1",
    initialAssumption: "Der Gate-Check blockiert Starts ohne Hypothese.",
    confidenceBefore: 0.6,
    criticalQuestions: ["Gilt das auch bei repo_path statt cluster_id?"],
    falsificationPlan: ["task_start ohne hypothesis_id aufrufen und Fehler erwarten"],
  });
  assert.equal(h.version, 1);
  assert.equal(h.status, "open");
  assert.equal(h.result, "open");
  assert.equal(h.confidenceBefore, 0.6);
  assert.equal(h.confidenceAfter, null);
  assert.equal(h.taskId, "T_1");
  assert.equal(h.criticalQuestions.length, 1);
  assert.equal(h.criticalQuestions[0].question, "Gilt das auch bei repo_path statt cluster_id?");
  assert.equal(h.falsificationPlan[0].description, "task_start ohne hypothesis_id aufrufen und Fehler erwarten");
  assert.ok(h.id.startsWith("H_"));
  assert.ok(h.createdAt);
});

test("Konfidenz außerhalb [0,1] wird abgelehnt", () => {
  const { repo } = freshRepo();
  assert.throws(() => repo.create({ initialAssumption: "x", confidenceBefore: 1.5 }), /außerhalb/);
  assert.throws(() => repo.create({ initialAssumption: "x", confidenceBefore: -0.1 }), /außerhalb/);
  assert.throws(() => repo.create({ initialAssumption: "", confidenceBefore: 0.5 }), /erforderlich/);
});

test("Aktualisierung ist append-only und versioniert", () => {
  const { repo } = freshRepo();
  const h1 = repo.create({ initialAssumption: "A", confidenceBefore: 0.5 });
  const h2 = repo.update(h1.id, {
    result: "confirmed",
    confidenceAfter: 0.9,
    updatedAssumption: "A gilt bestätigt.",
    addEvidence: ["Tests grün", "Gate blockiert wie erwartet"],
    status: "confirmed",
  });
  assert.equal(h2.version, 2);
  assert.equal(h2.result, "confirmed");
  assert.equal(h2.confidenceAfter, 0.9);
  assert.equal(h2.updatedAssumption, "A gilt bestätigt.");
  assert.equal(h2.evidence.length, 2);

  // Version 1 bleibt unverändert erhalten (Nachvollziehbarkeit).
  const v1 = repo.getVersion(h1.id, 1);
  assert.equal(v1.version, 1);
  assert.equal(v1.result, "open");
  assert.equal(v1.confidenceAfter, null);
  assert.equal(v1.evidence.length, 0);

  // get() liefert die neueste Version.
  assert.equal(repo.get(h1.id).version, 2);
  // Historie vollständig.
  const all = repo.listVersions(h1.id);
  assert.deepEqual(all.map((v) => v.version), [1, 2]);
});

test("Serialisierung ist verlustfrei (round-trip)", () => {
  const { repo } = freshRepo();
  const h = repo.create({
    planId: "P_1",
    taskId: "T_9",
    initialAssumption: "Serialisierung erhält alle Felder.",
    confidenceBefore: 0.42,
    criticalQuestions: ["Bleiben Objektfelder erhalten?"],
    falsificationPlan: ["round-trip vergleichen"],
  });
  const updated = repo.update(h.id, {
    addEvidence: ["ok"], result: "partially_confirmed", confidenceAfter: 0.7,
    followUpQuestions: ["Was bleibt offen?"],
  });
  const json = HypothesisRepo.serialize(updated);
  const back = HypothesisRepo.deserialize(json);
  assert.deepEqual(HypothesisRepo.serialize(back), json);
  // Pflichtfelder der Spezifikation vorhanden.
  for (const f of [
    "id", "taskId", "clusterId", "version", "initialAssumption", "confidenceBefore",
    "criticalQuestions", "falsificationPlan", "evidence", "result", "confidenceAfter",
    "updatedAssumption", "createdAt", "updatedAt",
  ]) {
    assert.ok(f in json, `Feld fehlt: ${f}`);
  }
});

test("Laden nach Task und Cluster", () => {
  const { repo } = freshRepo();
  repo.create({ taskId: "T_A", clusterId: "C1", initialAssumption: "a", confidenceBefore: 0.5 });
  repo.create({ taskId: "T_B", clusterId: "C1", initialAssumption: "b", confidenceBefore: 0.5 });
  repo.create({ taskId: "T_C", clusterId: "C2", initialAssumption: "c", confidenceBefore: 0.5 });
  assert.equal(repo.listByTask("T_A").length, 1);
  assert.equal(repo.listByCluster("C1").length, 2);
  assert.equal(repo.listByCluster("C2").length, 1);
  assert.equal(repo.latestForTask("T_A").initialAssumption, "a");
  assert.equal(repo.latestForTask("T_UNKNOWN"), undefined);
});

test("drei Prüfergebnisse: confirmed | partially_confirmed | refuted", () => {
  const { repo } = freshRepo();
  const mk = (r) => {
    const h = repo.create({ initialAssumption: "x", confidenceBefore: 0.5 });
    // partially_confirmed/refuted erfordern Folgefragen (Cluster 3).
    const followUpQuestions = r === "confirmed" ? undefined : ["offen?"];
    return repo.update(h.id, { result: r, confidenceAfter: 0.5, addEvidence: ["e"], followUpQuestions }).result;
  };
  assert.equal(mk("confirmed"), "confirmed");
  assert.equal(mk("partially_confirmed"), "partially_confirmed");
  assert.equal(mk("refuted"), "refuted");
});
