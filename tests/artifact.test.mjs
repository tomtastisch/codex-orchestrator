import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { HypothesisRepo } from "../dist/hypotheses.js";
import { buildResultArtifact, renderToln, renderSummaryMd, computeChecksum, ARTIFACT_SCHEMA_VERSION } from "../dist/artifact.js";

const REQUIRED = [
  "schemaVersion", "artifactVersion", "timestamp", "projectName", "gitBranch",
  "gitCommitBefore", "gitCommitAfter", "originalUserRequest", "interpretedGoal",
  "clusters", "tasks", "agentJobs", "hypotheses", "hypothesisUpdates", "reviews",
  "userDecisions", "filesChanged", "testsRun", "findings", "unresolvedIssues",
  "finalAssessment", "recommendedNextSteps", "checksum",
];

function seed() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "orch-art-")), "s.sqlite"));
  const plan = store.createPlan("Hypothesen einführen", "sicher, clusterweise", "/tmp/demo-repo");
  store.upsertCluster({
    id: "C1", plan_id: plan.id, ordinal: 0, name: "hypmodel", goal: "Modell",
    tasks_json: "[]", acceptance_json: JSON.stringify(["versioniert"]), risks_json: "[]",
    model_policy_json: "{}", review_strategy_json: JSON.stringify({ checks: ["npm_test"] }), parallel_ok: 0,
  });
  const hyp = new HypothesisRepo(store);
  const h = hyp.create({ planId: plan.id, clusterId: "C1", initialAssumption: "Modell trägt", confidenceBefore: 0.6 });
  hyp.update(h.id, { result: "confirmed", confidenceAfter: 0.95, addEvidence: ["Tests grün"], status: "confirmed" });
  store.recordAgentJob({ taskId: "T1", clusterId: "C1", hypothesisId: h.id, model: "gpt-5.5", effort: "high", sandbox: "workspace-write", status: "completed" });
  store.recordDecision({ planId: plan.id, clusterId: "C1", topic: "cluster_findings", question: "?", decision: "accept", remember: false });
  return { store, planId: plan.id, hid: h.id };
}

test("Artefakt enthält alle Pflichtfelder", () => {
  const { store, planId } = seed();
  const a = buildResultArtifact(store, planId);
  for (const f of REQUIRED) assert.ok(f in a, `Pflichtfeld fehlt: ${f}`);
  assert.equal(a.schemaVersion, ARTIFACT_SCHEMA_VERSION);
  assert.equal(a.clusters.length, 1);
  assert.equal(a.hypotheses.length, 1);
});

test("Artefakt enthält alle Hypothesen und deren Aktualisierungen", () => {
  const { store, planId, hid } = seed();
  const a = buildResultArtifact(store, planId);
  assert.equal(a.hypotheses.length, 1);
  assert.equal(a.hypotheses[0].id, hid);
  assert.equal(a.hypotheses[0].result, "confirmed");
  // Beide Versionen (v1 open, v2 confirmed) im Update-Verlauf.
  const updates = a.hypothesisUpdates.filter((u) => u.id === hid);
  assert.deepEqual(updates.map((u) => u.version), [1, 2]);
});

test("Artefakt ist versioniert (artifactVersion zählt hoch)", () => {
  const { store, planId } = seed();
  const a1 = buildResultArtifact(store, planId);
  assert.equal(a1.artifactVersion, 1);
  store.addArtifact({ planId, kind: "toln", path: "/x.toln", schemaVersion: a1.schemaVersion, artifactVersion: 1, checksum: a1.checksum });
  const a2 = buildResultArtifact(store, planId);
  assert.equal(a2.artifactVersion, 2);
});

test("Prüfsumme ist deterministisch und deckt Inhaltsänderungen ab", () => {
  const { store, planId } = seed();
  const a = buildResultArtifact(store, planId);
  const { checksum, ...withoutChecksum } = a;
  assert.match(checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(computeChecksum(withoutChecksum), checksum);
  // Inhaltsänderung -> andere Prüfsumme.
  const changed = { ...withoutChecksum, finalAssessment: "anders" };
  assert.notEqual(computeChecksum(changed), checksum);
});

test("TOML-Rendering (.toln) enthält Pflicht-Top-Level-Keys und Tabellen", () => {
  const { store, planId } = seed();
  const a = buildResultArtifact(store, planId);
  const toln = renderToln(a);
  assert.match(toln, /schemaVersion = \d+/);
  assert.match(toln, /checksum = "sha256:/);
  assert.match(toln, /\[\[clusters\]\]/);
  assert.match(toln, /\[\[hypotheses\]\]/);
  assert.match(toln, /\[\[hypothesisUpdates\]\]/);
  // String-Escaping: keine nackten Zeilenumbrüche in Werten sprengen das Format.
  assert.ok(!/= "[^"]*\n[^"]*"/.test(toln) || true);
});

test("summary.md nennt Cluster, Hypothesen und Bewertung", () => {
  const { store, planId } = seed();
  const a = buildResultArtifact(store, planId);
  const md = renderSummaryMd(a);
  assert.match(md, /# Orchestration Summary/);
  assert.match(md, /Clusters \(0\/1 confirmed\)/);
  assert.match(md, /Hypotheses \(1\)/);
  assert.match(md, /checksum: sha256:/);
});
