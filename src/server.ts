#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync as _existsSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync, mkdirSync as _mkdirSync } from "node:fs";
import { join as _join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { Store } from "./db.js";
import { SessionManager, isProcessAlive } from "./session.js";
import { ClusterStateMachine, mergeEligibility, type TransitionAction } from "./statemachine.js";
import { WorktreeManager, isGitRepo } from "./worktree.js";
import { runChecks, diffSize } from "./checks.js";
import { resolveModel, repoPathForCluster, latestWorktreeForCluster } from "./resolve.js";
import { isBlockedConfigKey } from "./codex.js";
import { centralAgentsMd } from "./agents.js";
import { checkForUpdate, runUpdate, type Channel } from "./updater.js";
import { buildDoctorReport } from "./doctor.js";
import { writePlanSnapshot } from "./snapshot.js";
import { writeResultArtifact } from "./artifact.js";
import { HypothesisRepo, needsFollowUp, type HypothesisResult } from "./hypotheses.js";
import { checkHypothesisGate } from "./gate.js";
import { checkSandboxPolicy } from "./sandbox.js";
import { EFFORT_LADDER } from "./types.js";
import type { Effort, Sandbox } from "./types.js";
import { createExecutionRuntime } from "./execution/registry.js";
import { ORCHESTRATOR_VERSION } from "./version.js";

const store = new Store(config.dbPath);
const execution = createExecutionRuntime(config);
const sessions = new SessionManager(store, (id) => execution.registry.get(id));
const hypRepo = new HypothesisRepo(store);
const machine = new ClusterStateMachine(store);
const worktrees = new WorktreeManager();

// Instanz-Advisory: warnen, wenn eine lebende Instanz denselben Store bedient.
(function instanceGuard() {
  try {
    _mkdirSync(config.home, { recursive: true });
    const lockPath = _join(config.home, "instance.json");
    if (_existsSync(lockPath)) {
      const prev = JSON.parse(_readFileSync(lockPath, "utf8"));
      if (prev?.pid && prev.pid !== process.pid && isProcessAlive(prev.pid)) {
        console.error(
          `[orchestrator] WARNUNG: Store ${config.home} wird bereits von PID ${prev.pid} (cwd ${prev.cwd}) bedient. ` +
          `Parallele Instanzen auf DEMSELBEN Store vermeiden — pro Projekt einen eigenen ORCH_HOME nutzen.`,
        );
      }
    }
    _writeFileSync(lockPath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() }), "utf8");
  } catch { /* best effort */ }
})();

console.error(`[orchestrator] Store: ${config.home} (cwd: ${process.cwd()})`);
const reaped = sessions.reapOnStartup();
if (reaped > 0) console.error(`[orchestrator] Reaper: ${reaped} verwaiste Task(s) toter Prozesse auf 'failed' gesetzt.`);

const server = new McpServer({ name: "codex-orchestrator", version: ORCHESTRATOR_VERSION });

function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], isError: true };
}

function executionTargetForCluster(clusterId: string) {
  const latest = store.listTasks({ clusterId }).at(-1);
  return execution.registry.get(latest?.target_id ?? "local");
}

server.registerPrompt(
  "codex_orchestrator",
  {
    title: "Codex Orchestrator",
    description: "Plan and supervise a Codex implementation through gated clusters.",
    argsSchema: {
      request: z.string().min(1).max(20_000),
    },
  },
  ({ request }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Run orchestrator_doctor first. Then decompose this request into gated clusters, " +
          "form explicit hypotheses, delegate bounded slices to Codex, review every result " +
          `and confirm only after declared checks pass. Request: ${request}`,
      },
    }],
  }),
);

server.registerPrompt(
  "orchestrator_status",
  {
    title: "Orchestrator Status",
    description: "Load the durable state of an orchestration plan.",
    argsSchema: {
      plan_id: z.string().optional(),
    },
  },
  ({ plan_id }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: plan_id
          ? `Call plan_snapshot for plan ${plan_id}, then summarize cluster, task, review and check status without changing state.`
          : "Identify the current plan from available task events, call plan_snapshot and summarize status without changing state.",
      },
    }],
  }),
);

server.registerTool(
  "orchestrator_doctor",
  {
    title: "Codex-Orchestrator Diagnose",
    description: "Prüft alle konfigurierten Execution-Targets inklusive Codex-Version und Authentifizierung. Remote-Auth wird gemäß Serverkonfiguration sicher initialisiert und danach erneut geprüft.",
    inputSchema: {},
  },
  async () => {
    const targets = [];
    for (const target of execution.registry.list()) {
      try {
        targets.push(await target.doctor());
      } catch (e: any) {
        targets.push({
          targetId: target.id,
          kind: target.kind,
          state: "unhealthy",
          codexVersion: null,
          auth: { state: "error", message: e?.message ?? String(e) },
          errorCode: e?.code ?? "TARGET_PROTOCOL",
          message: e?.message ?? String(e),
        });
      }
    }
    const healthy = targets.every((target) => target.state === "healthy");
    const local = targets.find((target) => target.targetId === "local");
    const environment = buildDoctorReport({
      codexVersion: local?.codexVersion ?? null,
      loginStatus: local?.auth?.state === "authenticated" ? "Logged in" : "Not logged in",
    });
    return (healthy ? ok : err)({
      ok: healthy,
      version: ORCHESTRATOR_VERSION,
      execution: config.execution.mode,
      environment,
      targets,
    });
  },
);

// ---------------------------------------------------------------- 7.1 task_start
server.registerTool(
  "task_start",
  {
    title: "Codex-Task/Slice starten",
    description:
      "Startet einen Codex-Auftrag als Slice-Folge. Kleine Aufgaben: wait_for='completed' (nur wenn Slice-Budget <= Sync-Limit). Große: 'started'/'first_checkpoint' + task_wait-Loop. danger-full-access ist unerreichbar.",
    inputSchema: {
      cluster_id: z.string().optional().describe("Cluster, zu dem der Task gehört (bestimmt Repo-Pfad)."),
      repo_path: z.string().optional().describe("Repo-Pfad, falls kein cluster_id angegeben ist."),
      hypothesis_id: z.string().optional().describe("PFLICHT: id der zuvor gebildeten Hypothese (hypotheses → create). Ohne verknüpfte Hypothese wird der Start blockiert."),
      instructions: z.string().describe("Konkrete Arbeitsanweisung für Codex."),
      acceptance_criteria: z.array(z.string()).optional(),
      sandbox: z.enum(["read-only", "workspace-write"]),
      model: z.string().default("auto").describe("'auto' oder konkreter Modellname aus models_list (z. B. gpt-5.5, gpt-5.4, gpt-5.4-mini)."),
      effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium").describe("Reasoning effort: low|medium|high|xhigh (extra hoch)."),
      slice_budget: z
        .object({ max_minutes: z.number().int().positive().default(8), stop_condition: z.string().optional() })
        .optional(),
      wait_for: z.enum(["started", "first_checkpoint", "completed"]).default("started"),
      worktree: z.string().default("none").describe("'none' (Repo direkt), 'auto' (isoliertes Worktree) oder Pfad."),
      network: z.boolean().optional().describe("Netzwerkzugriff für den Slice (Default: Server-Policy, i.d.R. aus)."),
      extra_config: z.record(z.string()).optional().describe("Zusätzliche codex -c key=value Overrides. Sicherheitskritische Keys (sandbox_mode, danger*, approval_policy, model, notify) werden ignoriert."),
    },
  },
  async (a) => {
    const effort = a.effort as Effort;
    // Cluster 7: Sandbox-Policy fail-closed prüfen (gefährliche Modi -> klare Ablehnung + Audit).
    const sandboxCheck = checkSandboxPolicy(a.sandbox);
    if (!sandboxCheck.ok) {
      store.addAuditEvent({
        actor: "claude", action: sandboxCheck.dangerous ? "danger_mode_denied" : "sandbox_rejected",
        resource: a.cluster_id ?? a.repo_path ?? null, detail: { requested: a.sandbox }, redacted: false,
      });
      return err({ ok: false, error: sandboxCheck.error });
    }
    const sandbox = sandboxCheck.sandbox as Sandbox;
    const maxMinutes = a.slice_budget?.max_minutes ?? 8;
    const stopCondition = a.slice_budget?.stop_condition ?? null;
    const waitFor = a.wait_for;

    let repoPath: string | null = null;
    if (a.cluster_id) {
      repoPath = repoPathForCluster(store, a.cluster_id);
      if (!repoPath) return err({ ok: false, error: `Cluster ${a.cluster_id} oder Plan-Repo nicht gefunden` });
    } else if (a.repo_path) {
      repoPath = a.repo_path;
    } else {
      return err({ ok: false, error: "cluster_id oder repo_path erforderlich" });
    }

    if (waitFor === "completed" && maxMinutes > config.syncMaxMinutes) {
      return err({
        ok: false,
        error: `wait_for='completed' nur bei slice_budget.max_minutes <= ${config.syncMaxMinutes} zulässig`,
      });
    }

    // Cluster 2: Pflicht-Hypothesen-Gate. Kein Agentenjob ohne verknüpfte Hypothese.
    const gate = checkHypothesisGate(hypRepo, { hypothesisId: a.hypothesis_id }, config.requireHypothesis);
    if (!gate.ok) {
      return err({ ok: false, error: gate.error, hint: "hypotheses → create, dann hypothesis_id an task_start übergeben." });
    }

    let selection;
    try {
      selection = await execution.router.select(repoPath);
    } catch (e: any) {
      return err({ ok: false, error: `Execution-Target nicht verfügbar: ${e?.message ?? e}`, code: e?.code });
    }

    // Worktree-Isolation. 'auto' wird NACH der Task-Erstellung mit der echten
    // task.id angelegt (konsistente Benennung); hier nur früh validieren.
    const wantAutoWorktree = a.worktree === "auto";
    let worktree: string | null = null;
    let branch: string | null = null;
    if (wantAutoWorktree) {
      if (selection.target.kind === "local" && !isGitRepo(repoPath)) {
        return err({ ok: false, error: `worktree:auto benötigt ein git-Repo: ${repoPath}` });
      }
    } else if (a.worktree && a.worktree !== "none") {
      worktree = a.worktree;
    }

    const model = resolveModel(a.model ?? "auto", effort);
    // Modell/Effort gegen den Katalog prüfen (fail-closed bei bekanntem Modell).
    const known = config.availableModels.find((m) => m.model === model);
    if (known && !known.efforts.includes(effort)) {
      return err({
        ok: false,
        error: `Effort '${effort}' für Modell '${model}' nicht zulässig. Erlaubt: ${known.efforts.join(", ")}`,
      });
    }
    const modelNote = known ? undefined : `Hinweis: Modell '${model}' ist nicht im Katalog (models_list) — wird ungeprüft an Codex übergeben.`;

    // extra_config filtern (fail-closed): sicherheitskritische Keys verwerfen.
    let extraConfig: Record<string, string> | undefined;
    const droppedConfig: string[] = [];
    if (a.extra_config) {
      extraConfig = {};
      for (const [k, v] of Object.entries(a.extra_config)) {
        if (isBlockedConfigKey(k)) droppedConfig.push(k);
        else extraConfig[k] = String(v);
      }
      if (Object.keys(extraConfig).length === 0) extraConfig = undefined;
    }

    const task = sessions.createTask({
      clusterId: a.cluster_id ?? null,
      repoPath,
      worktree,
      branch,
      instructions: a.instructions,
      acceptance: a.acceptance_criteria ?? [],
      sandbox,
      model,
      effort,
      network: a.network ?? config.networkDefault,
      maxMinutes,
      extraConfig,
      targetId: selection.target.id,
      targetKind: selection.target.kind,
      repositoryCommit: selection.repository.headCommit,
      routingReason: selection.reason,
      fallbackFrom: selection.fallbackFrom,
      hypothesisId: a.hypothesis_id ?? null,
    });

    // Hypothese provenienzhalber an Task/Cluster binden (Header-Update, keine neue Version).
    if (a.hypothesis_id) {
      try { hypRepo.bindToTask(a.hypothesis_id, task.id, a.cluster_id ?? null); } catch { /* best effort */ }
    }

    // Cluster 5: auditierbaren agent_job-Datensatz anlegen (wird bei Task-Ende abgeschlossen).
    try {
      store.recordAgentJob({
        taskId: task.id, clusterId: a.cluster_id ?? null, hypothesisId: a.hypothesis_id ?? null,
        model, effort, sandbox, status: "queued",
      });
    } catch { /* best effort */ }

    // Cluster 7: sicherheitsrelevantes Audit-Event (gewählte Sandbox, verworfene Config-Keys).
    try {
      store.addAuditEvent({
        actor: "claude", action: "task_started", resource: task.id,
        detail: { sandbox, model, effort, network: a.network ?? config.networkDefault, dropped_config_keys: droppedConfig },
        redacted: false,
      });
    } catch { /* best effort */ }

    // Auto-Worktree jetzt mit echter task.id anlegen -> Verzeichnis/Branch = task.id.
    if (wantAutoWorktree) {
      try {
        const wt = selection.target.kind === "ssh" && selection.target.createWorktree
          ? await selection.target.createWorktree(repoPath, task.id)
          : worktrees.create(repoPath, task.id);
        worktree = wt.worktree;
        branch = wt.branch;
        store.updateTask(task.id, { worktree, branch });
      } catch (e: any) {
        store.updateTask(task.id, { status: "failed", ended_at: new Date().toISOString() });
        return err({ ok: false, task_id: task.id, error: `Worktree-Erstellung fehlgeschlagen: ${e?.message ?? e}` });
      }
    }

    sessions.startLoop(task.id, stopCondition);
    const dropped = droppedConfig.length ? { dropped_config_keys: droppedConfig } : {};

    if (waitFor === "started") {
      return ok({ ok: true, task_id: task.id, status: "queued", model, effort, worktree, branch,
        target: selection.target.id, routing_reason: selection.reason, fallback_from: selection.fallbackFrom,
        note: modelNote, ...dropped });
    }
    if (waitFor === "first_checkpoint") {
      await sessions.waitUntil(task.id, (_s, sawSlice) => sawSlice, config.maxWaitSeconds);
    } else {
      // completed
      await sessions.waitUntil(
        task.id,
        (s) => ["completed", "failed", "cancelled", "blocked"].includes(s),
        maxMinutes * 60 + 30,
      );
    }
    const t = store.getTask(task.id)!;
    const lastSlice = store
      .eventsAfter(task.id, 0, ["slice_result"], 50)
      .map((e) => JSON.parse(e.payload_json))
      .at(-1);
    return ok({ ok: true, task_id: task.id, status: t.status, model, effort, worktree, branch, last_slice_result: lastSlice ?? null, note: modelNote, ...dropped });
  },
);

// ---------------------------------------------------------------- 7.2 task_wait
server.registerTool(
  "task_wait",
  {
    title: "Long-Poll auf Task-Events",
    description:
      "Kehrt zurück bei neuem Event (seq>cursor), Slice-Ende, Statuswechsel oder Timeout. Kernprimitive des Orchestrierungs-Loops (MCP ist pull-basiert).",
    inputSchema: {
      task_id: z.string(),
      cursor: z.number().int().nonnegative().default(0),
      timeout_seconds: z.number().int().positive().default(50),
    },
  },
  async (a) => {
    const r = await sessions.wait(a.task_id, a.cursor, a.timeout_seconds);
    return ok(r);
  },
);

// ---------------------------------------------------------------- 7.3 task_events
server.registerTool(
  "task_events",
  {
    title: "Historische Events cursorbasiert abrufen",
    description: "Ruft Events mit seq>cursor ab, optional gefiltert nach kind.",
    inputSchema: {
      task_id: z.string(),
      cursor: z.number().int().nonnegative().default(0),
      kinds: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(500).default(200),
    },
  },
  async (a) => {
    const rows = store.eventsAfter(a.task_id, a.cursor, a.kinds, a.limit);
    const events = rows.map((e) => ({ seq: e.seq, ts: e.ts, kind: e.kind, payload: JSON.parse(e.payload_json) }));
    const cursor = events.length ? events[events.length - 1].seq : a.cursor;
    return ok({ task_id: a.task_id, events, cursor });
  },
);

// ---------------------------------------------------------------- 7.4 task_control
server.registerTool(
  "task_control",
  {
    title: "Task steuern",
    description:
      "pause (kein Auto-Resume nach Slice), resume, cancel (SIGTERM->SIGKILL, Worktree bleibt), inject (Nachricht an nächster Slice-Grenze).",
    inputSchema: {
      task_id: z.string(),
      action: z.enum(["pause", "resume", "cancel", "inject"]),
      message: z.string().optional(),
      priority: z.enum(["normal", "high"]).default("normal"),
    },
  },
  async (a) => {
    switch (a.action) {
      case "pause":
        return ok({ action: "pause", ...sessions.pause(a.task_id) });
      case "resume":
        return ok({ action: "resume", ...sessions.resume(a.task_id) });
      case "cancel":
        return ok({ action: "cancel", ...sessions.cancel(a.task_id) });
      case "inject": {
        if (!a.message) return err({ ok: false, error: "inject erfordert 'message'" });
        return ok({ action: "inject", ...sessions.inject(a.task_id, a.message, a.priority) });
      }
    }
  },
);

// ---------------------------------------------------------------- 7.5 task_result
server.registerTool(
  "task_result",
  {
    title: "Konsolidierte Task-Abgabe",
    description:
      "Diff-Zusammenfassung (Datei-Liste, Zeilenstatistik), Testresultate, letzte SLICE_RESULT-Blöcke, offene Punkte. Keine vollständigen Diffs/Logs.",
    inputSchema: { task_id: z.string(), max_slice_results: z.number().int().positive().max(20).default(3) },
  },
  async (a) => {
    const t = store.getTask(a.task_id);
    if (!t) return err({ ok: false, error: "unbekannter Task" });
    const sliceResults = store
      .eventsAfter(a.task_id, 0, ["slice_result"], 100)
      .map((e) => JSON.parse(e.payload_json));
    const recent = sliceResults.slice(-a.max_slice_results);
    const repo = t.worktree || t.repo_path;
    const target = execution.registry.get(t.target_id);
    let diff = { files: 0, lines: 0 };
    try {
      diff = await diffSize(repo, target);
    } catch { /* ignore */ }
    const tests = recent.flatMap((r) => r.tests ?? []);
    const openItems = recent.flatMap((r) => r.open_items ?? []);
    const changed = [...new Set(recent.flatMap((r) => r.changed_files ?? []))];
    return ok({
      ok: true,
      task_id: t.id,
      status: t.status,
      slice_count: t.slice_count,
      last_slice_type: t.last_slice_type,
      last_summary: t.last_summary,
      diff_summary: diff,
      changed_files: changed,
      tests_run: tests,
      open_items: openItems,
      recent_slice_results: recent,
      limits: {
        max_diff_lines: config.limits.maxDiffLines,
        max_diff_files: config.limits.maxDiffFiles,
        over_diff_limit: diff.lines > config.limits.maxDiffLines || diff.files > config.limits.maxDiffFiles,
      },
    });
  },
);

// ---------------------------------------------------------------- 7.6 models_list
server.registerTool(
  "models_list",
  {
    title: "Verfügbare Modellklassen",
    description: "Statische Routing-Tabelle (Plan §9). Claude wählt Klasse+Effort pro Phase; Namen nie hartkodieren.",
    inputSchema: {},
  },
  async () => ok({
    available_models: config.availableModels,
    class_defaults: config.models,
    effort_ladder: EFFORT_LADDER,
    usage: "task_start akzeptiert model=<konkreter Name> ODER 'auto', plus effort=low|medium|high|xhigh. Bei model:'auto' bestimmt der Effort die Klasse (low->fast, medium->balanced, high/xhigh->strong).",
    escalation_rule: "Zwei fehlgeschlagene Korrektur-Slices in Folge -> nächste Effort-Stufe (low->medium->high->xhigh) oder stärkeres Modell. Im Event-Log dokumentieren.",
    routing_table: [
      { phase: "Analyse/Recherche", model: "gpt-5.4-mini", effort: "low", sandbox: "read-only" },
      { phase: "Architekturprüfung", model: "gpt-5.5", effort: "high", sandbox: "read-only" },
      { phase: "Implementierung", model: "gpt-5.5", effort: "medium", sandbox: "workspace-write" },
      { phase: "Tests", model: "gpt-5.4", effort: "medium", sandbox: "workspace-write" },
      { phase: "CI-Fix (komplex)", model: "gpt-5.5", effort: "high", sandbox: "workspace-write" },
      { phase: "Review", model: "gpt-5.5", effort: "high", sandbox: "read-only" },
      { phase: "kritische Analyse/Sparring", model: "gpt-5.5", effort: "xhigh", sandbox: "read-only" },
      { phase: "Dokumentation", model: "gpt-5.4-mini", effort: "low", sandbox: "workspace-write" },
    ],
  }),
);

// ---------------------------------------------------------------- 7.7 cluster_plan
server.registerTool(
  "cluster_plan",
  {
    title: "Clusterplan anlegen/aktualisieren",
    description: "Persistierter Plan mit Clustern (Gates, Acceptance, Risiken, Modellpolitik, Sandbox, Review-Strategie). Idempotent über plan_id.",
    inputSchema: {
      plan_id: z.string().optional().describe("Weglassen für neuen Plan."),
      goal: z.string(),
      constraints: z.string().optional(),
      repo_path: z.string(),
      clusters: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          goal: z.string(),
          tasks: z.array(z.string()).default([]),
          acceptance: z.array(z.string()).default([]),
          risks: z.array(z.string()).optional(),
          model_policy: z
            .object({
              class: z.enum(["fast", "balanced", "strong"]).default("balanced"),
              effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
              sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
              model: z.string().optional().describe("Konkreter Modellname für diesen Cluster (sonst 'auto')."),
            })
            .default({ class: "balanced", effort: "medium", sandbox: "workspace-write" }),
          review_strategy: z
            .object({ checks: z.array(z.string()).default([]), codex_review: z.boolean().default(false), notes: z.string().optional() })
            .default({ checks: [], codex_review: false }),
          parallel_ok: z.boolean().default(false),
        }),
      ),
    },
  },
  async (a) => {
    return store.tx(() => {
      let planId = a.plan_id;
      if (!planId || !store.getPlan(planId)) {
        const p = store.createPlan(a.goal, a.constraints ?? null, a.repo_path);
        planId = p.id;
      }
      const persisted = a.clusters.map((c, i) =>
        store.upsertCluster({
          id: c.id,
          plan_id: planId!,
          ordinal: i,
          name: c.name,
          goal: c.goal,
          tasks_json: JSON.stringify(c.tasks),
          acceptance_json: JSON.stringify(c.acceptance),
          risks_json: JSON.stringify(c.risks ?? []),
          model_policy_json: JSON.stringify(c.model_policy),
          review_strategy_json: JSON.stringify(c.review_strategy),
          parallel_ok: c.parallel_ok ? 1 : 0,
        }),
      );
      return ok({
        ok: true,
        plan_id: planId,
        clusters: persisted.map((c) => ({ id: c.id, ordinal: c.ordinal, name: c.name, status: c.status })),
      });
    });
  },
);

// ---------------------------------------------------------------- 7.8 cluster_transition
server.registerTool(
  "cluster_transition",
  {
    title: "Cluster-Statusübergang (servererzwungen)",
    description:
      "start|submit|review|request_changes|confirm|block|retro|replan. confirm scheitert ohne REVIEW_RESULT=confirmed UND grüne deklarierte Checks. review führt deklarierte Checks aus (run_checks=false zum Abschalten).",
    inputSchema: {
      cluster_id: z.string(),
      action: z.enum(["start", "submit", "review", "request_changes", "confirm", "block", "retro", "replan"]),
      payload: z.record(z.any()).optional(),
    },
  },
  async (a) => {
    const payload = a.payload ?? {};
    // review: deklarierte Checks vorab ausführen, damit die confirm-Bedingung greifen kann.
    if (a.action === "review" && payload.run_checks !== false) {
      const cluster = store.getCluster(a.cluster_id);
      const repo = repoPathForCluster(store, a.cluster_id);
      if (cluster && repo) {
        const strategy = JSON.parse(cluster.review_strategy_json || "{}");
        const declared: string[] = strategy.checks ?? [];
        if (declared.length) {
          const scope = latestWorktreeForCluster(store, a.cluster_id) || repo;
          const res = await runChecks(store, a.cluster_id, scope, declared, executionTargetForCluster(a.cluster_id));
          payload.checks_run = res.runs;
        }
      }
    }
    const r = machine.transition(a.cluster_id, a.action as TransitionAction, payload);
    return r.ok ? ok(r) : err(r);
  },
);

// ---------------------------------------------------------------- 7.9 hypotheses
server.registerTool(
  "hypotheses",
  {
    title: "Hypothesen führen (versioniert)",
    description:
      "Legacy: list|add|confirm|reject|supersede (plan-weite Freitext-Hypothesen). " +
      "Reiches, versioniertes Modell: create|update|get|versions. " +
      "'create' bildet die Pflicht-Hypothese VOR einer Aufgabe (initialAssumption + criticalQuestions + falsificationPlan). " +
      "'update' aktualisiert append-only NACH der Aufgabe (result + evidence + updatedAssumption).",
    inputSchema: {
      plan_id: z.string().optional().describe("Für list/add/create (plan-weite Gruppierung)."),
      action: z.enum([
        "list", "add", "confirm", "reject", "supersede",
        "create", "update", "get", "versions",
      ]),
      id: z.string().optional(),
      text: z.string().optional().describe("Legacy add: Freitext."),
      evidence: z.string().optional().describe("Legacy: Provenienz."),
      // --- reiches Modell ---
      task_id: z.string().optional(),
      cluster_id: z.string().optional(),
      initial_assumption: z.string().optional().describe("create: die Ausgangsannahme."),
      confidence_before: z.number().min(0).max(1).optional().describe("create: Konfidenz [0,1] vor der Aufgabe."),
      critical_questions: z.array(z.string()).optional().describe("create: aktives Hinterfragen."),
      falsification_plan: z.array(z.string()).optional().describe("create: wie könnte die Annahme scheitern?"),
      result: z.enum(["open", "confirmed", "partially_confirmed", "refuted"]).optional().describe("update: Prüfergebnis."),
      confidence_after: z.number().min(0).max(1).optional().describe("update: Konfidenz [0,1] nach der Aufgabe."),
      updated_assumption: z.string().optional().describe("update: revidierte Annahme / Folgehypothese."),
      add_evidence: z.array(z.string()).optional().describe("update: gefundene Evidenz."),
      follow_up_questions: z.array(z.string()).optional().describe("update: PFLICHT bei partially_confirmed/refuted — was bleibt offen?"),
      risks: z.array(z.string()).optional().describe("update: erkannte Risiken/Folgeprobleme."),
      next_action: z.string().optional().describe("update: nächste sinnvolle Aktion."),
      status: z.enum(["open", "confirmed", "rejected", "superseded"]).optional(),
      version: z.number().int().positive().optional().describe("get: konkrete Version (sonst neueste)."),
    },
  },
  async (a) => {
    try {
      switch (a.action) {
        case "list":
          if (!a.plan_id) return err({ ok: false, error: "list erfordert 'plan_id'" });
          return ok({
            plan_id: a.plan_id,
            hypotheses: store.listHypotheses(a.plan_id),
            rich: hypRepo.listByPlan(a.plan_id).map((h) => HypothesisRepo.serialize(h)),
          });
        case "add": {
          if (!a.plan_id) return err({ ok: false, error: "add erfordert 'plan_id'" });
          if (!a.text) return err({ ok: false, error: "add erfordert 'text'" });
          const id = store.addHypothesis(a.plan_id, a.text, a.evidence ?? null);
          return ok({ ok: true, id });
        }
        case "confirm":
        case "reject":
        case "supersede": {
          if (!a.id) return err({ ok: false, error: `${a.action} erfordert 'id'` });
          const status = a.action === "confirm" ? "confirmed" : a.action === "reject" ? "rejected" : "superseded";
          store.setHypothesis(a.id, status, a.evidence ?? null);
          return ok({ ok: true, id: a.id, status });
        }
        case "create": {
          if (!a.initial_assumption) return err({ ok: false, error: "create erfordert 'initial_assumption'" });
          if (a.confidence_before === undefined) return err({ ok: false, error: "create erfordert 'confidence_before' [0,1]" });
          const h = hypRepo.create({
            planId: a.plan_id ?? null,
            taskId: a.task_id ?? null,
            clusterId: a.cluster_id ?? null,
            initialAssumption: a.initial_assumption,
            confidenceBefore: a.confidence_before,
            criticalQuestions: a.critical_questions,
            falsificationPlan: a.falsification_plan,
          });
          return ok({ ok: true, hypothesis: HypothesisRepo.serialize(h) });
        }
        case "update": {
          if (!a.id) return err({ ok: false, error: "update erfordert 'id'" });
          const h = hypRepo.update(a.id, {
            status: a.status,
            result: a.result as HypothesisResult | undefined,
            confidenceAfter: a.confidence_after,
            updatedAssumption: a.updated_assumption,
            addEvidence: a.add_evidence,
            followUpQuestions: a.follow_up_questions,
            risks: a.risks,
            nextAction: a.next_action,
            criticalQuestions: a.critical_questions,
            falsificationPlan: a.falsification_plan,
            taskId: a.task_id,
            clusterId: a.cluster_id,
          });
          return ok({ ok: true, needs_follow_up: needsFollowUp(h.result), hypothesis: HypothesisRepo.serialize(h) });
        }
        case "get": {
          if (!a.id) return err({ ok: false, error: "get erfordert 'id'" });
          const h = a.version ? hypRepo.getVersion(a.id, a.version) : hypRepo.get(a.id);
          if (!h) return err({ ok: false, error: `Hypothese ${a.id} (v${a.version ?? "latest"}) nicht gefunden` });
          return ok({ ok: true, hypothesis: HypothesisRepo.serialize(h) });
        }
        case "versions": {
          if (!a.id) return err({ ok: false, error: "versions erfordert 'id'" });
          return ok({ ok: true, id: a.id, versions: hypRepo.listVersions(a.id).map((h) => HypothesisRepo.serialize(h)) });
        }
      }
    } catch (e: any) {
      return err({ ok: false, error: e?.message ?? String(e) });
    }
  },
);

// ---------------------------------------------------------------- 7.9b user_decision
server.registerTool(
  "user_decision",
  {
    title: "Nutzerentscheidungen & Präferenzen (Cluster-Gate)",
    description:
      "record|list|preference. Bei Review-Auffälligkeiten fragt Claude den Nutzer, ob nachgebessert werden soll; " +
      "die Antwort wird hier persistiert. 'accept'/'proceed' gibt den Cluster-Abschluss trotz Findings frei, " +
      "'fix' fordert Nachbesserung. Mit remember=true wird die Antwort zur stehenden Präferenz (plan-weit).",
    inputSchema: {
      action: z.enum(["record", "list", "preference"]),
      plan_id: z.string().optional(),
      cluster_id: z.string().optional(),
      topic: z.string().default("cluster_findings").describe("Entscheidungsthema. Default: Review-Auffälligkeiten."),
      question: z.string().optional().describe("Die dem Nutzer gestellte Frage (für Audit)."),
      decision: z.enum(["accept", "proceed", "fix", "always_ask"]).optional(),
      remember: z.boolean().default(false).describe("Als stehende Präferenz merken (künftig automatisch anwenden)."),
    },
  },
  async (a) => {
    switch (a.action) {
      case "record": {
        if (!a.decision) return err({ ok: false, error: "record erfordert 'decision'" });
        const id = store.recordDecision({
          planId: a.plan_id ?? null,
          clusterId: a.cluster_id ?? null,
          topic: a.topic,
          question: a.question ?? null,
          decision: a.decision,
          remember: a.remember,
        });
        return ok({ ok: true, id, decision: a.decision, remember: a.remember });
      }
      case "list":
        return ok({ ok: true, decisions: store.listDecisions({ clusterId: a.cluster_id, planId: a.plan_id }) });
      case "preference": {
        const pref = store.standingPreference(a.plan_id ?? null, a.topic);
        return ok({ ok: true, topic: a.topic, preference: pref ?? null });
      }
    }
  },
);

// ---------------------------------------------------------------- 7.9c audit_log
server.registerTool(
  "audit_log",
  {
    title: "Sicherheitsrelevanter Audit-Trail",
    description:
      "Liest die Audit-Events (Sandbox-Wahl, abgelehnte Gefahrmodi, verworfene Config-Keys, Artefakt-Erzeugung). " +
      "Alle Details sind bereits Secret-redacted. Für Firmeneinsatz/Nachvollziehbarkeit.",
    inputSchema: { limit: z.number().int().positive().max(1000).default(200) },
  },
  async (a) => ok({ ok: true, events: store.listAuditEvents(a.limit) }),
);

// ---------------------------------------------------------------- 7.10 repo_check
server.registerTool(
  "repo_check",
  {
    title: "Allowlisted Repo-Checks",
    description:
      "Führt nur allowlisted Kommandos aus (keine freie Shell). Ergebnisse fließen in die confirm-Bedingung. Prüft zusätzlich Diff-Limits.",
    inputSchema: {
      cluster_id: z.string(),
      checks: z.array(z.string()),
      scope: z.enum(["worktree", "branch"]).default("branch"),
    },
  },
  async (a) => {
    const repo = repoPathForCluster(store, a.cluster_id);
    if (!repo) return err({ ok: false, error: "Plan-Repo für Cluster nicht gefunden" });
    const target = a.scope === "worktree" ? latestWorktreeForCluster(store, a.cluster_id) || repo : repo;
    const executionTarget = executionTargetForCluster(a.cluster_id);
    const res = await runChecks(store, a.cluster_id, target, a.checks, executionTarget);
    let diff = { files: 0, lines: 0 };
    try {
      diff = await diffSize(target, executionTarget);
    } catch { /* ignore */ }
    return ok({
      ok: true,
      cluster_id: a.cluster_id,
      scope: a.scope,
      target,
      runs: res.runs,
      all_green: res.allGreen,
      unknown_checks: res.unknown,
      available_checks: Object.keys(config.checks),
      diff_summary: diff,
      over_diff_limit: diff.lines > config.limits.maxDiffLines || diff.files > config.limits.maxDiffFiles,
    });
  },
);

// -------------------------------------------------- M3-Ergänzung: cluster_merge
server.registerTool(
  "cluster_merge",
  {
    title: "Worktree-Branch mergen (M3, sequenziell nach Review)",
    description:
      "Merged den Branch eines parallelen Tasks erst nach confirmed Cluster/Review und grünen Checks. Konflikt -> Merge wird abgebrochen.",
    inputSchema: {
      cluster_id: z.string(),
      task_id: z.string(),
      no_ff: z.boolean().default(true),
      sign: z.boolean().optional().describe("Merge-Commit signieren. Default: Server-Policy (ORCH_SIGN_MERGE)."),
      cleanup: z.boolean().default(false).describe("Worktree + Branch nach erfolgreichem Merge entfernen."),
    },
  },
  async (a) => {
    const repo = repoPathForCluster(store, a.cluster_id);
    if (!repo) return err({ ok: false, error: "Plan-Repo nicht gefunden" });
    const cluster = store.getCluster(a.cluster_id);
    if (!cluster) return err({ ok: false, error: "Cluster nicht gefunden" });
    const task = store.getTask(a.task_id);
    if (!task || !task.branch) return err({ ok: false, error: "Task ohne Worktree-Branch" });
    const review = store.latestReview(a.cluster_id);
    const strategy = JSON.parse(cluster.review_strategy_json || "{}") as { checks?: string[] };
    const checks = store.checksForCluster(a.cluster_id);
    const checksGreen = (strategy.checks ?? []).every((name) => {
      const latest = [...checks].reverse().find((check) => check.cmd === name);
      return latest?.exit_code === 0;
    });
    const eligibility = mergeEligibility({
      clusterId: cluster.id,
      taskClusterId: task.cluster_id,
      taskStatus: task.status,
      clusterStatus: cluster.status,
      reviewStatus: review?.status ?? null,
      checksGreen,
    });
    if (!eligibility.ok) {
      return err({ ok: false, error: "Merge-Gates nicht erfüllt", reasons: eligibility.reasons });
    }
    const sign = a.sign ?? config.signMergeCommits;
    const target = execution.registry.get(task.target_id);
    const r = target.kind === "ssh" && target.mergeWorktree
      ? await target.mergeWorktree(repo, task.branch, { noFf: a.no_ff, noGpgSign: !sign })
      : worktrees.merge(repo, task.branch, { noFf: a.no_ff, noGpgSign: !sign });
    if (!r.ok) {
      return err({ ok: false, conflict: r.conflict, error: "Merge fehlgeschlagen", output: r.output.slice(-1500) });
    }
    let cleaned = false;
    if (a.cleanup && task.worktree) {
      try {
        if (target.kind === "ssh" && target.removeWorktree) {
          await target.removeWorktree(repo, task.worktree, task.branch);
        } else {
          worktrees.remove(repo, task.worktree, task.branch);
        }
        store.updateTask(task.id, { worktree: null });
        cleaned = true;
      } catch { /* Worktree bleibt für Forensik */ }
    }
    return ok({ ok: true, merged: task.branch, cleaned, output: r.output.slice(-1000) });
  },
);

// -------------------------------------------------- plan_snapshot (TOON/JSON)
server.registerTool(
  "plan_snapshot",
  {
    title: "Plan-Zustand als durables Snapshot (TOON/JSON)",
    description:
      "Schreibt Plan+Cluster+Hypothesen+Reviews+Checks als kompaktes, kompressionssicheres Artefakt (TOON default) nach ORCH_HOME/snapshots und gibt den Inhalt zurück. Gegen Kontext-Kompaktierung.",
    inputSchema: {
      plan_id: z.string(),
      format: z.enum(["toon", "json"]).default("toon"),
    },
  },
  async (a) => {
    const res = writePlanSnapshot(store, a.plan_id, a.format);
    if (!res) return err({ ok: false, error: "Plan nicht gefunden" });
    return ok({ ok: true, format: res.format, path: res.path, content: res.content });
  },
);

// -------------------------------------------------- result_artifact (.toln)
server.registerTool(
  "result_artifact",
  {
    title: "Finales Gesamtartefakt erzeugen (.toln)",
    description:
      "Erzeugt am Ende eines Orchestrator-Laufs ein versioniertes, maschinenlesbares Ergebnisartefakt: " +
      "TOML mit Endung .toln (+ summary.md). Enthält Plan, Cluster, Tasks, Agentenjobs, alle Hypothesen und " +
      "ihre Aktualisierungen, Reviews, Nutzerentscheidungen, geänderte Dateien, Tests, Findings, offene Punkte, " +
      "Gesamtbewertung und Prüfsumme. Registriert das Artefakt in der DB.",
    inputSchema: {
      plan_id: z.string(),
      original_request: z.string().optional(),
      interpreted_goal: z.string().optional(),
      final_assessment: z.string().optional(),
      recommended_next_steps: z.array(z.string()).optional(),
      git_commit_before: z.string().optional().describe("Basis-Commit für die Datei-Diff-Ermittlung (sonst HEAD~1)."),
    },
  },
  async (a) => {
    const res = writeResultArtifact(store, a.plan_id, {
      originalUserRequest: a.original_request,
      interpretedGoal: a.interpreted_goal,
      finalAssessment: a.final_assessment,
      recommendedNextSteps: a.recommended_next_steps,
      gitCommitBefore: a.git_commit_before ?? null,
    });
    if (!res) return err({ ok: false, error: "Plan nicht gefunden" });
    store.addAuditEvent({
      actor: "claude", action: "result_artifact_generated", resource: a.plan_id,
      detail: { path: res.tolnPath, artifactVersion: res.artifact.artifactVersion, checksum: res.artifact.checksum },
      redacted: false,
    });
    return ok({
      ok: true,
      toln_path: res.tolnPath,
      summary_path: res.summaryPath,
      schema_version: res.artifact.schemaVersion,
      artifact_version: res.artifact.artifactVersion,
      checksum: res.artifact.checksum,
      clusters: res.artifact.clusters.length,
      hypotheses: res.artifact.hypotheses.length,
      unresolved: res.artifact.unresolvedIssues.length,
    });
  },
);

// -------------------------------------------------- codex_update (Auto-Update)
server.registerTool(
  "codex_update",
  {
    title: "Codex-CLI prüfen/aktualisieren",
    description:
      "Prüft (check) oder installiert (apply) die neueste Codex-Version via npm. Kanäle: latest (stabil), alpha/beta (prerelease, z. B. für neue Modelle). Nicht anwenden, solange Tasks laufen.",
    inputSchema: {
      action: z.enum(["check", "apply"]).default("check"),
      channel: z.enum(["latest", "alpha", "beta"]).default("latest"),
    },
  },
  async (a) => {
    const channel = a.channel as Channel;
    const running = store.listTasks({ status: "running" }).length + store.listTasks({ status: "awaiting_resume" }).length;
    const chk = checkForUpdate(channel, config.codexBin);
    if (a.action === "check") return ok({ ok: true, ...chk, running_tasks: running });
    if (running > 0) {
      return err({ ok: false, error: `Update abgelehnt: ${running} Task(s) aktiv. Erst abschließen/pausieren.`, ...chk });
    }
    if (!chk.updateAvailable) return ok({ ok: true, applied: false, reason: "bereits aktuell", ...chk });
    const res = await runUpdate(channel);
    return res.ok
      ? ok({ ok: true, applied: true, from: chk.installed, to: chk.latest, channel })
      : err({ ok: false, applied: false, error: "npm install fehlgeschlagen", output: res.output });
  },
);

// Zentrale Executor-AGENTS.md bereitstellen.
centralAgentsMd();

// F: Graceful Shutdown — laufende Codex-Kinder terminieren, instance.json aufräumen.
let shuttingDown = false;
function gracefulShutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const n = sessions.shutdown();
    console.error(`[orchestrator] ${sig}: ${n} laufende(n) Slice(s) terminiert.`);
  } catch { /* ignore */ }
  try {
    const lockPath = _join(config.home, "instance.json");
    const prev = _existsSync(lockPath) ? JSON.parse(_readFileSync(lockPath, "utf8")) : null;
    if (prev?.pid === process.pid) _writeFileSync(lockPath, JSON.stringify({ pid: null, cwd: process.cwd(), stoppedAt: new Date().toISOString() }));
  } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[orchestrator] codex-orchestrator v${ORCHESTRATOR_VERSION} läuft (stdio). DB: ${config.dbPath}`);
