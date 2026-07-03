import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { HypothesisRepo, needsFollowUp } from "../dist/hypotheses.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "orch-hu-"));
  const store = new Store(join(dir, "s.sqlite"));
  return new HypothesisRepo(store);
}

function seed(repo) {
  return repo.create({ taskId: "T1", initialAssumption: "Annahme", confidenceBefore: 0.6 });
}

test("bestätigte Hypothese: kein Folgefrage-Zwang", () => {
  const repo = fresh();
  const h = seed(repo);
  const updated = repo.update(h.id, {
    result: "confirmed",
    confidenceAfter: 0.95,
    addEvidence: ["Alle Tests grün", "Verhalten wie erwartet"],
    updatedAssumption: "Annahme bestätigt.",
    status: "confirmed",
  });
  assert.equal(updated.result, "confirmed");
  assert.equal(needsFollowUp(updated.result), false);
  assert.equal(updated.evidence.length, 2);
  assert.equal(updated.version, 2);
});

test("teilweise bestätigt: Folgefragen sind Pflicht", () => {
  const repo = fresh();
  const h = seed(repo);
  // Ohne Folgefragen -> abgelehnt.
  assert.throws(
    () => repo.update(h.id, { result: "partially_confirmed", addEvidence: ["nur teilweise"] }),
    /Folgefrage/,
  );
  // Mit Folgefragen -> ok.
  const updated = repo.update(h.id, {
    result: "partially_confirmed",
    addEvidence: ["Kernpfad ok, Randfall offen"],
    followUpQuestions: ["Wie verhält sich der Randfall X?"],
    risks: ["Randfall könnte in Produktion auftreten"],
    nextAction: "Zusätzlichen Test für Randfall X ergänzen",
  });
  assert.equal(updated.result, "partially_confirmed");
  assert.equal(needsFollowUp(updated.result), true);
  assert.equal(updated.followUpQuestions.length, 1);
  assert.equal(updated.risks.length, 1);
  assert.match(updated.nextAction, /Randfall X/);
});

test("widerlegt: Folgefragen sind Pflicht und neue Hypothese wird dokumentiert", () => {
  const repo = fresh();
  const h = seed(repo);
  assert.throws(() => repo.update(h.id, { result: "refuted" }), /Folgefrage/);
  const updated = repo.update(h.id, {
    result: "refuted",
    confidenceAfter: 0.1,
    addEvidence: ["Gegenbeweis: Test rot"],
    updatedAssumption: "Neue Hypothese: Ursache liegt in Modul Y.",
    followUpQuestions: ["Ist Modul Y die tatsächliche Ursache?"],
    status: "rejected",
  });
  assert.equal(updated.result, "refuted");
  assert.equal(updated.status, "rejected");
  assert.match(updated.updatedAssumption, /Modul Y/);
  assert.equal(updated.followUpQuestions.length, 1);
});

test("Statusverlauf ist über Versionen nachvollziehbar", () => {
  const repo = fresh();
  const h = seed(repo);
  repo.update(h.id, {
    result: "partially_confirmed",
    followUpQuestions: ["offen?"],
    addEvidence: ["e1"],
  });
  repo.update(h.id, { result: "confirmed", status: "confirmed", addEvidence: ["e2"] });
  const versions = repo.listVersions(h.id);
  assert.deepEqual(versions.map((v) => v.result), ["open", "partially_confirmed", "confirmed"]);
  // Evidenz akkumuliert monoton.
  assert.deepEqual(versions.map((v) => v.evidence.length), [0, 1, 2]);
});
