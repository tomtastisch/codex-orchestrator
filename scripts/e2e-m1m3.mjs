// M1 (Slice-Loop, Resume, Injection, pause/resume) + M3 (Worktree-Isolation, Merge).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = mkdtempSync(join(tmpdir(), "orch-m1-repo-"));
const orchHome = mkdtempSync(join(tmpdir(), "orch-m1-home-"));
for (const args of [["init", "-q"], ["config", "user.email", "e2e@t.local"], ["config", "user.name", "e2e"], ["config", "commit.gpgsign", "false"], ["config", "tag.gpgsign", "false"], ["commit", "--allow-empty", "-q", "-m", "init"]])
  spawnSync("git", args, { cwd: repo });
console.log("repo:", repo);

const transport = new StdioClientTransport({
  command: "node", args: [join(process.cwd(), "dist/server.js")],
  env: { ...process.env, ORCH_HOME: orchHome },
});
const client = new Client({ name: "e2e-m1", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text }; }
  return { isError: !!r.isError, data };
};
let failures = 0, softWarn = 0;
const hard = (c, l, x) => { console.log(`${c ? "✔" : "✘"} ${l}${x ? "  " + JSON.stringify(x) : ""}`); if (!c) failures++; };
const soft = (c, l, x) => { console.log(`${c ? "✔" : "⚠"} ${l}${x ? "  " + JSON.stringify(x) : ""}`); if (!c) softWarn++; };

async function waitStatus(taskId, wanted, maxSec = 300) {
  const deadline = Date.now() + maxSec * 1000; let cursor = 0; let last = "";
  while (Date.now() < deadline) {
    const r = await call("task_wait", { task_id: taskId, cursor, timeout_seconds: 30 });
    cursor = r.data.cursor; last = r.data.task_status;
    for (const e of r.data.events) console.log(`   · [${e.seq}] ${e.kind}` + (e.payload?.type ? ` (${e.payload.type})` : ""));
    if (wanted.includes(last)) return { status: last, cursor };
  }
  return { status: last, cursor };
}

// Plan + Cluster (workspace-write, Review-Check git_status).
const plan = await call("cluster_plan", {
  goal: "M1/M3 Nachweis", repo_path: repo,
  clusters: [{
    id: "C1", name: "twostep", goal: "zwei Dateien in zwei Slices",
    tasks: ["a.txt", "b.txt"], acceptance: ["a.txt=A und b.txt=B liegen vor"],
    model_policy: { class: "fast", effort: "low", sandbox: "workspace-write" },
    review_strategy: { checks: ["git_status"] },
  }],
});
hard(plan.data.ok, "cluster_plan");
await call("cluster_transition", { cluster_id: "C1", action: "start" });

// Pflicht-Hypothese VOR dem Task (Cluster-2-Gate).
const hyp = await call("hypotheses", {
  action: "create", plan_id: plan.data.plan_id, cluster_id: "C1",
  initial_assumption: "Codex legt a.txt=A und b.txt=B in zwei separaten Slices an.",
  confidence_before: 0.7,
  critical_questions: ["Trennt Codex die beiden Schritte sauber auf zwei Slices?"],
  falsification_plan: ["a.txt/b.txt-Inhalte nach den Slices prüfen"],
});
hard(hyp.data.ok, "Pflicht-Hypothese angelegt");

// Task im ISOLIERTEN Worktree (M3), asynchron (wait_for started).
const start = await call("task_start", {
  cluster_id: "C1",
  hypothesis_id: hyp.data.hypothesis.id,
  instructions:
    "This task has exactly two steps done in separate slices.\n" +
    "SLICE 1 (now): create a file a.txt containing exactly 'A'. Then STOP. Report Type: checkpoint. " +
    "Do NOT create b.txt in this slice.\n" +
    "SLICE 2 (only after you receive further instructions): create b.txt, then finish with Type: submission.",
  acceptance_criteria: ["a.txt contains A", "b.txt contains B"],
  sandbox: "workspace-write", model: "auto", effort: "low",
  slice_budget: { max_minutes: 4 }, wait_for: "started", worktree: "auto",
});
hard(start.data.ok, "task_start (worktree:auto)", { worktree: !!start.data.worktree, branch: start.data.branch });
const taskId = start.data.task_id;
const worktree = start.data.worktree;
hard(!!worktree && existsSync(worktree), "M3: isoliertes Worktree existiert", { worktree });
hard(worktree.endsWith("/" + taskId), "D: Worktree-Verzeichnis = echte task.id", { base: worktree.split("/").pop(), taskId });

// Sofort pausieren -> greift am nächsten Slice-Ende (dokumentierte Latenz).
await call("task_control", { task_id: taskId, action: "pause" });

// Warten auf paused ODER terminal (falls Codex den Checkpoint ignoriert).
const s1 = await waitStatus(taskId, ["paused", "completed", "blocked", "failed"], 300);
console.log("   -> Status nach Slice 1:", s1.status);

const aPath = join(worktree, "a.txt");
soft(existsSync(aPath), "Slice 1: a.txt im Worktree erstellt", { exists: existsSync(aPath) });

if (s1.status === "paused") {
  // Injection + Resume -> Injection muss im Folge-Slice ankommen (M1-Kernnachweis).
  await call("task_control", { task_id: taskId, action: "inject", message: "SLICE 2 now: create b.txt containing exactly 'B', then finish with Type: submission.", priority: "high" });
  await call("task_control", { task_id: taskId, action: "resume" });
  const s2 = await waitStatus(taskId, ["completed", "blocked", "failed"], 300);
  console.log("   -> Status nach Slice 2:", s2.status);
  const ev = await call("task_events", { task_id: taskId, cursor: 0, kinds: ["injection_delivered"] });
  soft(ev.data.events.length > 0, "M1: injection_delivered Event vorhanden", { n: ev.data.events.length });
  hard(s2.status === "completed", "Task nach Resume completed");
} else {
  soft(false, "Codex hat Checkpoint nicht abgewartet — Injection-Pfad übersprungen", { status: s1.status });
  hard(s1.status === "completed", "Task terminal completed");
}

// Beide Dateien im Worktree?
const bPath = join(worktree, "b.txt");
hard(existsSync(aPath) && existsSync(bPath), "beide Dateien im Worktree", {
  a: existsSync(aPath), b: existsSync(bPath),
});

// M3-Merge: erst Review, dann Merge in den Basis-Branch.
await call("cluster_transition", { cluster_id: "C1", action: "submit" });
await call("cluster_transition", { cluster_id: "C1", action: "review", payload: { status: "confirmed" } });
// Worktree committen, damit Merge etwas zu übertragen hat.
spawnSync("git", ["add", "-A"], { cwd: worktree });
spawnSync("git", ["commit", "-q", "-m", "slices"], { cwd: worktree });
const merge = await call("cluster_merge", { cluster_id: "C1", task_id: taskId, no_ff: true, cleanup: true });
hard(merge.data.ok === true, "M3: cluster_merge erfolgreich", { conflict: merge.data.conflict, err: merge.data.error });
hard(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")), "Merge: Dateien im Basis-Repo angekommen");
hard(merge.data.cleaned === true && !existsSync(worktree), "I: Worktree nach Merge aufgeräumt", { cleaned: merge.data.cleaned, stillThere: existsSync(worktree) });

console.log(`\n=== M1/M3 ${failures === 0 ? "BESTANDEN" : "FEHLGESCHLAGEN (" + failures + ")"} ${softWarn ? "(" + softWarn + " weiche Warnung(en))" : ""} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
