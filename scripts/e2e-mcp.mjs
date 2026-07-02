// End-to-End-Test: echter MCP-Client -> gebauter Server -> echter Codex-Slice.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = mkdtempSync(join(tmpdir(), "orch-e2e-repo-"));
const orchHome = mkdtempSync(join(tmpdir(), "orch-e2e-home-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
spawnSync("git", ["config", "user.email", "e2e@test.local"], { cwd: repo });
spawnSync("git", ["config", "user.name", "e2e"], { cwd: repo });
spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repo });
console.log("repo:", repo, "\norchHome:", orchHome);

const transport = new StdioClientTransport({
  command: "node",
  args: [join(process.cwd(), "dist/server.js")],
  env: { ...process.env, ORCH_HOME: orchHome },
});
const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text }; }
  return { isError: !!r.isError, data };
};

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✔" : "�’✘"} ${label}${extra ? "  " + JSON.stringify(extra) : ""}`);
  if (!cond) failures++;
};

// 0) Tools vorhanden
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
check(names.length >= 10, `Tools registriert (${names.length})`, names);

// 1) Plan + Cluster
const plan = await call("cluster_plan", {
  goal: "E2E: triviale Dateierstellung",
  repo_path: repo,
  clusters: [{
    id: "C1", name: "hello", goal: "hello.txt anlegen",
    tasks: ["hello.txt schreiben"], acceptance: ["hello.txt enthält 'hello world'"],
    model_policy: { class: "fast", effort: "low", sandbox: "workspace-write" },
    review_strategy: { checks: ["git_status"], codex_review: false },
  }],
});
check(plan.data.ok === true, "cluster_plan", { plan_id: plan.data.plan_id });
const planId = plan.data.plan_id;

// 2) start-Gate
const start = await call("cluster_transition", { cluster_id: "C1", action: "start" });
check(start.data.status === "active", "cluster start -> active");

// 3) confirm VOR Arbeit muss scheitern (aus 'active' ohnehin nicht erlaubt)
const prematureConfirm = await call("cluster_transition", { cluster_id: "C1", action: "confirm" });
check(prematureConfirm.isError === true, "confirm vorzeitig verweigert", { error: prematureConfirm.data.error });

// 4) task_start synchron (M0-Pfad)
console.log("... starte Codex-Slice (kann ~1 Min dauern) ...");
const task = await call("task_start", {
  cluster_id: "C1",
  instructions: "Create a file named hello.txt in the working directory whose ONLY content is the exact text: hello world  (a single line). Then you are done.",
  acceptance_criteria: ["hello.txt exists and contains 'hello world'"],
  sandbox: "workspace-write",
  model: "auto",
  effort: "low",
  slice_budget: { max_minutes: 5 },
  wait_for: "completed",
});
check(task.data.ok === true, "task_start abgeschlossen", { status: task.data.status });
check(task.data.status === "completed", "Task-Status completed", { last: task.data.last_slice_result?.type });
const taskId = task.data.task_id;

// 5) Datei tatsächlich erstellt?
const filePath = join(repo, "hello.txt");
const fileOk = existsSync(filePath) && /hello world/i.test(readFileSync(filePath, "utf8"));
check(fileOk, "hello.txt erstellt & korrekt", { exists: existsSync(filePath) });

// AGENTS.md muss für Codex bereitgestellt worden sein (Executor-Rolle).
const agentsPath = join(repo, "AGENTS.md");
const agentsOk = existsSync(agentsPath) && /codex-orchestrator/.test(readFileSync(agentsPath, "utf8"));
check(agentsOk, "Codex hatte AGENTS.md (Executor-Rolle)", { exists: existsSync(agentsPath) });

// 6) task_result
const result = await call("task_result", { task_id: taskId });
check(result.data.ok === true, "task_result", {
  changed: result.data.changed_files, diff: result.data.diff_summary, slices: result.data.slice_count,
});

// 7) task_events zeigt slice_result
const events = await call("task_events", { task_id: taskId, cursor: 0, kinds: ["slice_result", "task_status"] });
check(events.data.events.some((e) => e.kind === "slice_result"), "slice_result Event persistiert");

// 8) Confirm-Gate live: submit -> review (führt git_status aus) -> confirm
await call("cluster_transition", { cluster_id: "C1", action: "submit" });
const review = await call("cluster_transition", { cluster_id: "C1", action: "review", payload: { status: "confirmed", findings: [] } });
check(review.data.status === "in_review", "review -> in_review (Checks liefen)");
const confirm = await call("cluster_transition", { cluster_id: "C1", action: "confirm" });
check(confirm.data.ok === true && confirm.data.status === "confirmed", "confirm mit grünem Check erlaubt", { err: confirm.data.error });

// 9) Retro-Pflicht
const retro = await call("cluster_transition", { cluster_id: "C1", action: "retro", payload: { content: "E2E gelernt: Pfad funktioniert." } });
check(retro.data.ok === true, "retro persistiert");

// 10) models_list
const models = await call("models_list", {});
check(
  Array.isArray(models.data.available_models) && models.data.available_models.length === 3 &&
    JSON.stringify(models.data.effort_ladder) === JSON.stringify(["low", "medium", "high", "xhigh"]),
  "models_list (available_models + effort_ladder)",
  models.data.available_models?.map((m) => m.model),
);

console.log(`\n=== E2E ${failures === 0 ? "BESTANDEN" : "FEHLGESCHLAGEN (" + failures + ")"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
