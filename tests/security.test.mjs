import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { HypothesisRepo } from "../dist/hypotheses.js";
import { buildResultArtifact, renderToln } from "../dist/artifact.js";
import { checkSandboxPolicy, classifySandbox, ALLOWED_SANDBOXES, DEFAULT_SANDBOX } from "../dist/sandbox.js";
import { redactText, redactDeep, containsSecret } from "../dist/redact.js";

function freshStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), "orch-sec-")), "s.sqlite"));
}

// -------- Sandbox-Policy --------
test("read-only ist der Default und erlaubt", () => {
  assert.equal(DEFAULT_SANDBOX, "read-only");
  assert.deepEqual([...ALLOWED_SANDBOXES], ["read-only", "workspace-write"]);
  assert.equal(checkSandboxPolicy("read-only").ok, true);
  assert.equal(checkSandboxPolicy("workspace-write").ok, true);
});

test("danger-full-access wird abgelehnt und benötigt explizite Freigabe", () => {
  const r = checkSandboxPolicy("danger-full-access");
  assert.equal(r.ok, false);
  assert.equal(r.dangerous, true);
  assert.match(r.error, /explizite Nutzerfreigabe/);
  assert.equal(classifySandbox("danger-full-access"), "danger");
});

test("unbekannter Sandbox-Modus -> klare Fehlermeldung statt blindem Durchlassen", () => {
  const r = checkSandboxPolicy("yolo-mode");
  assert.equal(r.ok, false);
  assert.equal(r.dangerous, false);
  assert.match(r.error, /Unbekannter Sandbox-Modus/);
});

// -------- Redaction --------
test("redactText maskiert verbreitete Secret-Formate", () => {
  const samples = [
    "sk-proj-ABCDEFGHIJKLMNOP1234567890",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "OPENAI_API_KEY=super-secret-value-123",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart",
  ];
  for (const s of samples) {
    assert.ok(containsSecret(s), `sollte als Secret erkannt werden: ${s}`);
    assert.ok(!containsSecret(redactText(s)), `Redaction unvollständig: ${s}`);
  }
});

test("redactText lässt harmlosen Text unangetastet", () => {
  const s = "Cluster C1 confirmed, 54 Tests grün, keine Auffälligkeiten.";
  assert.equal(redactText(s), s);
});

test("redactDeep scrubbt verschachtelte Strukturen", () => {
  const obj = { a: "OPENAI_API_KEY=abcdef123456", nested: { list: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ok"] } };
  const out = redactDeep(obj);
  assert.ok(!containsSecret(JSON.stringify(out)));
  assert.equal(out.nested.list[1], "ok");
});

// -------- Audit-Events werden redacted gespeichert --------
test("audit_events speichern keine Secrets", () => {
  const store = freshStore();
  store.addAuditEvent({
    actor: "claude", action: "task_started", resource: "T1",
    detail: { note: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 im Text" },
  });
  const evs = store.listAuditEvents();
  assert.equal(evs.length, 1);
  assert.ok(!containsSecret(evs[0].detail_json), "Audit-Detail enthält noch ein Secret");
  assert.equal(evs[0].redacted, 1);
});

// -------- Artefakt enthält keine Secrets --------
test("das .toln-Artefakt enthält keine Secrets (Evidenz wird gescrubbt)", () => {
  const store = freshStore();
  const plan = store.createPlan("goal", null, "/tmp/demo-repo");
  const hyp = new HypothesisRepo(store);
  const h = hyp.create({ planId: plan.id, initialAssumption: "x", confidenceBefore: 0.5 });
  hyp.update(h.id, {
    result: "confirmed", status: "confirmed",
    addEvidence: ["Env geleakt: OPENAI_API_KEY=leak-secret-abcdef123456"],
  });
  const a = buildResultArtifact(store, plan.id);
  const toln = renderToln(a);
  assert.ok(!containsSecret(toln), "Artefakt enthält ein Secret");
  assert.ok(!containsSecret(JSON.stringify(a)), "Artefakt-Objekt enthält ein Secret");
});
