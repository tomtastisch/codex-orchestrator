import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexArgs, isBlockedConfigKey } from "../dist/codex.js";
import { Store } from "../dist/db.js";
import { buildPlanSnapshot } from "../dist/snapshot.js";
import { buildFirstSlicePrompt, buildResumeSlicePrompt } from "../dist/prompts.js";
import { encode as toonEncode } from "@toon-format/toon";

test("buildCodexArgs setzt Sandbox/Modell/Effort/Netzwerk deterministisch", () => {
  const { args } = buildCodexArgs({ sandbox: "workspace-write", model: "gpt-5.5", effort: "xhigh", network: false });
  const joined = args.join(" ");
  assert.match(joined, /sandbox_mode=workspace-write/);
  assert.match(joined, /model=gpt-5\.5/);
  assert.match(joined, /model_reasoning_effort=xhigh/);
  assert.match(joined, /sandbox_workspace_write\.network_access=false/);
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-");
});

test("buildCodexArgs resume nutzt thread_id, network=true", () => {
  const { args } = buildCodexArgs({ threadId: "abc", sandbox: "read-only", model: "gpt-5.4", effort: "low", network: true });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[2], "abc");
  assert.match(args.join(" "), /network_access=true/);
});

test("buildCodexArgs: extra_config wird durchgereicht, gefährliche Keys verworfen", () => {
  const { args, droppedConfigKeys } = buildCodexArgs({
    sandbox: "read-only", model: "gpt-5.5", effort: "medium", network: false,
    extraConfig: {
      "model_verbosity": "concise",
      "sandbox_mode": "danger-full-access",
      "dangerously_bypass": "true",
      "approval_policy": "never",
      "model": "evil",
    },
  });
  const joined = args.join(" ");
  assert.match(joined, /model_verbosity=concise/);          // erlaubt
  assert.ok(!/danger-full-access/.test(joined));            // blockiert
  assert.ok(!joined.includes("evil"));                      // model-Override blockiert
  assert.deepEqual(droppedConfigKeys.sort(), ["approval_policy", "dangerously_bypass", "model", "sandbox_mode"].sort());
});

test("isBlockedConfigKey deckt Sandbox/Netzwerk/Danger/RCE-Vektoren ab", () => {
  for (const k of ["sandbox_mode", "sandbox_permissions", "approval_policy", "model", "notify",
                    "dangerously_bypass_approvals_and_sandbox", "sandbox_workspace_write.network_access",
                    "mcp_servers.evil.command", "shell_environment_policy.inherit", "hooks.on_start",
                    "projects./x.trust_level", "features.foo", "key with space", "a=b"]) {
    assert.equal(isBlockedConfigKey(k), true, k);
  }
  // Legitime Feinjustierung bleibt erlaubt:
  for (const k of ["model_verbosity", "model_reasoning_summary", "hide_agent_reasoning"]) {
    assert.equal(isBlockedConfigKey(k), false, k);
  }
});

test("read-only executor instructions stay in the prompt and do not mutate AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-agents-"));
  const agentsPath = join(dir, "AGENTS.md");
  const original = "# Projektregeln\nBitte Tests grün halten.\n";
  writeFileSync(agentsPath, original);
  const store = new Store(join(dir, "state.sqlite"));
  const task = store.createTask({
    id: "T_prompt", cluster_id: null, codex_session_id: null, worktree: null, branch: null,
    repo_path: dir, sandbox: "read-only", model: "gpt-5.5", effort: "low",
    instructions: "analysiere", acceptance_json: "[]", max_minutes: 5, network: 0,
    status: "queued", extra_config_json: null, owner_pid: null,
  });

  const prompt = buildFirstSlicePrompt(task, [], null);

  assert.match(prompt, /implementation executor/);
  assert.match(prompt, /Do NOT modify files/);
  assert.match(prompt, /SLICE_RESULT/);
  assert.equal(readFileSync(agentsPath, "utf8"), original);
});

test("resume prompt preserves injections, acceptance criteria and slice contract", () => {
  const task = { cluster_id: "C1", max_minutes: 7 };
  const prompt = buildResumeSlicePrompt(
    task,
    [
      { priority: "high", message: "Behebe Finding P1." },
      { priority: "normal", message: "Führe den Regressionstest aus." },
    ],
    ["Windows-Shim startet", "Alle Tests sind grün"],
  );

  assert.match(prompt, /highest priority/);
  assert.match(prompt, /\[high\] Behebe Finding P1/);
  assert.match(prompt, /\[normal\] Führe den Regressionstest aus/);
  assert.match(prompt, /about 7 minutes/);
  assert.match(prompt, /Windows-Shim startet/);
  assert.match(prompt, /SLICE_RESULT/);
});

test("Hypothesen-Lebenszyklus + Provenienz", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "orch-h-")), "s.sqlite"));
  const p = store.createPlan("g", null, "/tmp/r");
  const id = store.addHypothesis(p.id, "Annahme", null);
  assert.equal(store.listHypotheses(p.id)[0].status, "open");
  store.setHypothesis(id, "confirmed", "Beleg: Test grün");
  const h = store.listHypotheses(p.id)[0];
  assert.equal(h.status, "confirmed");
  assert.match(h.evidence, /Beleg/);
  store.setHypothesis(id, "superseded", null);
  assert.equal(store.listHypotheses(p.id)[0].status, "superseded");
  assert.match(store.listHypotheses(p.id)[0].evidence, /Beleg/); // evidence bleibt via COALESCE
});

test("Schema CHECK-Constraint lehnt ungültigen Hypothesen-Status ab", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "orch-h2-")), "s.sqlite"));
  const p = store.createPlan("g", null, "/tmp/r");
  assert.throws(() => {
    store.db.prepare("INSERT INTO hypotheses(id,plan_id,text,status,evidence,updated_at) VALUES(?,?,?,?,?,?)")
      .run("Hbad", p.id, "x", "bogus_status", null, new Date().toISOString());
  });
});

test("TOON-Snapshot enthält Plan/Cluster/Hypothesen und ist kompakt", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "orch-snap-")), "s.sqlite"));
  const p = store.createPlan("Ziel X", "keine externen Deps", "/tmp/r");
  store.upsertCluster({
    id: "C1", plan_id: p.id, ordinal: 0, name: "core", goal: "g",
    tasks_json: '["t1","t2"]', acceptance_json: '["a1"]', risks_json: "[]",
    model_policy_json: '{"model":"gpt-5.5","effort":"high"}',
    review_strategy_json: '{"checks":["npm_test"]}', parallel_ok: 0,
  });
  store.addHypothesis(p.id, "H1 Text", "e");
  const snap = buildPlanSnapshot(store, p.id);
  assert.equal(snap.plan.id, p.id);
  assert.equal(snap.clusters.length, 1);
  assert.deepEqual(snap.clusters[0].tasks, ["t1", "t2"]);
  assert.equal(snap.clusters[0].model_policy.model, "gpt-5.5");
  assert.equal(snap.hypotheses.length, 1);
  const toon = toonEncode(snap);
  assert.match(toon, /plan:/);
  assert.match(toon, /clusters/);
  assert.ok(toon.length < JSON.stringify(snap, null, 2).length); // kompakter als pretty-JSON
});
