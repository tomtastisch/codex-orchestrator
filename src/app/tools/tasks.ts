import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { config } from "../../config.js";
import { isGitRepo } from "../../worktree.js";
import { diffSize } from "../../checks.js";
import { resolveModel, repoPathForCluster } from "../../resolve.js";
import { isBlockedConfigKey } from "../../codex.js";
import { checkHypothesisGate } from "../../gate.js";
import { checkSandboxPolicy } from "../../sandbox.js";
import { type Effort, type Sandbox } from "../../types.js";
import { assertGitRepositoryRoot } from "../../project-boundary.js";

export function registerTaskTools(server: McpServer, ctx: AppContext): void {
  const { store, execution, sessions, hypRepo, worktrees, ok, err } = ctx;

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
      worktree: z.enum(["none", "auto"]).default("none").describe("'none' (Repo direkt) oder 'auto' (serververwaltetes isoliertes Worktree)."),
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
    try {
      if (a.cluster_id) {
        repoPath = repoPathForCluster(store, a.cluster_id);
        if (!repoPath) return err({ ok: false, error: `Cluster ${a.cluster_id} oder Plan-Repo nicht gefunden` });
      } else if (a.repo_path !== undefined) {
        repoPath = assertGitRepositoryRoot(a.repo_path);
      } else {
        return err({ ok: false, error: "cluster_id oder repo_path erforderlich" });
      }
    } catch (e: any) {
      return err({ ok: false, error: e?.message ?? String(e) });
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

    // Governance-kritische Persistenz wird NICHT stumm verschluckt: schlägt sie
    // fehl, sammeln wir eine Warnung und geben sie in der Tool-Antwort zurück, statt
    // stillen Erfolg vorzutäuschen (Provenienz/Ledger/Audit müssen sichtbar bleiben).
    const warnings: { code: string; message: string }[] = [];

    // Hypothese provenienzhalber an Task/Cluster binden (Header-Update, keine neue Version).
    // Autoritative Verknüpfung ist die Header-Spalte hypotheses.task_id; tasks.hypothesis_id
    // ist der Rückverweis. Schlägt das Binden fehl, divergieren beide Richtungen —
    // das darf nicht nur ephemer in der Antwort stehen, sondern braucht eine
    // dauerhafte Audit-Spur für die spätere Provenienz-Rekonziliation.
    if (a.hypothesis_id) {
      try { hypRepo.bindToTask(a.hypothesis_id, task.id, a.cluster_id ?? null); }
      catch (e: any) {
        warnings.push({ code: "provenance_bind_failed", message: String(e?.message ?? e) });
        try {
          store.addAuditEvent({
            actor: "claude", action: "provenance_bind_failed", resource: task.id,
            detail: { hypothesis_id: a.hypothesis_id, cluster_id: a.cluster_id ?? null, error: String(e?.message ?? e) },
            redacted: false,
          });
        } catch (auditErr: any) {
          console.error(`[orchestrator] provenance_bind_failed-Audit für ${task.id} nicht persistiert: ${auditErr?.message ?? auditErr}`);
        }
      }
    }

    // Cluster 5: auditierbaren agent_job-Datensatz anlegen (wird bei Task-Ende abgeschlossen).
    try {
      store.recordAgentJob({
        taskId: task.id, clusterId: a.cluster_id ?? null, hypothesisId: a.hypothesis_id ?? null,
        model, effort, sandbox, status: "queued",
      });
    } catch (e: any) { warnings.push({ code: "agent_job_persist_failed", message: String(e?.message ?? e) }); }

    // Cluster 7: sicherheitsrelevantes Audit-Event (gewählte Sandbox, verworfene Config-Keys).
    try {
      store.addAuditEvent({
        actor: "claude", action: "task_started", resource: task.id,
        detail: { sandbox, model, effort, network: a.network ?? config.networkDefault, dropped_config_keys: droppedConfig },
        redacted: false,
      });
    } catch (e: any) {
      warnings.push({ code: "audit_persist_failed", message: String(e?.message ?? e) });
      console.error(`[orchestrator] Audit-Event 'task_started' für ${task.id} nicht persistiert: ${e?.message ?? e}`);
    }

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
        // Fail-closed: Task auf failed setzen (clock-gestempelt) UND den offenen
        // agent_job schließen, damit kein Ledger-Eintrag als 'queued' hängen bleibt.
        const reason = `Worktree-Erstellung fehlgeschlagen: ${e?.message ?? e}`;
        store.failTask(task.id, reason);
        return err({ ok: false, task_id: task.id, error: reason });
      }
    }

    sessions.startLoop(task.id, stopCondition);
    const dropped = droppedConfig.length ? { dropped_config_keys: droppedConfig } : {};
    const warn = warnings.length ? { warnings } : {};

    if (waitFor === "started") {
      return ok({ ok: true, task_id: task.id, status: "queued", model, effort, worktree, branch,
        target: selection.target.id, routing_reason: selection.reason, fallback_from: selection.fallbackFrom,
        note: modelNote, ...dropped, ...warn });
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
    return ok({ ok: true, task_id: task.id, status: t.status, model, effort, worktree, branch, last_slice_result: lastSlice ?? null, note: modelNote, ...dropped, ...warn });
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

}
