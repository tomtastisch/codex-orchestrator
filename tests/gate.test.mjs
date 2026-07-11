import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { checkHypothesisGate } from "../dist/gate.js";
import { createSystemHypothesisRepo, createSystemStore } from "./helpers/system-deps.mjs";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "orch-gate-"));
  const store = createSystemStore(join(dir, "s.sqlite"));
  return { store, repo: createSystemHypothesisRepo(store) };
}

test("Gate blockiert Start ohne hypothesis_id", () => {
  const { repo } = fresh();
  const r = checkHypothesisGate(repo, { hypothesisId: undefined }, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /zwingend eine Hypothese/);
});

test("Gate blockiert leere hypothesis_id", () => {
  const { repo } = fresh();
  const r = checkHypothesisGate(repo, { hypothesisId: "   " }, true);
  assert.equal(r.ok, false);
});

test("Gate blockiert nicht existierende hypothesis_id", () => {
  const { repo } = fresh();
  const r = checkHypothesisGate(repo, { hypothesisId: "H_doesnotexist" }, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /existiert nicht/);
});

test("Gate lässt gültige Hypothese durch", () => {
  const { repo } = fresh();
  const h = repo.create({ initialAssumption: "Gate greift", confidenceBefore: 0.5 });
  const r = checkHypothesisGate(repo, { hypothesisId: h.id }, true);
  assert.equal(r.ok, true);
  assert.equal(r.hypothesis.id, h.id);
});

test("Gate abschaltbar (require=false) für Kompatibilität/Notausstieg", () => {
  const { repo } = fresh();
  const r = checkHypothesisGate(repo, { hypothesisId: undefined }, false);
  assert.equal(r.ok, true);
});

test("Task speichert Verknüpfung und Bindung aktualisiert Header", () => {
  const { store, repo } = fresh();
  const h = repo.create({ initialAssumption: "x", confidenceBefore: 0.5 });
  const task = store.createTask({
    id: "T_gate", cluster_id: null, codex_session_id: null, worktree: null, branch: null,
    repo_path: "/tmp/r", sandbox: "read-only", model: "m", effort: "low",
    instructions: "i", acceptance_json: "[]", max_minutes: 5, network: 0,
    status: "queued", extra_config_json: null, owner_pid: null, hypothesis_id: h.id,
  });
  assert.equal(task.hypothesis_id, h.id);
  repo.bindToTask(h.id, "T_gate", "C1");
  assert.equal(repo.listByTask("T_gate").length, 1);
  assert.equal(repo.listByCluster("C1")[0].id, h.id);
});
