import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { config } from "../../config.js";
import { centralAgentsMd } from "../../agents.js";
import { checkForUpdate, runUpdate, type Channel } from "../../updater.js";
import { buildDoctorReport } from "../../doctor.js";
import { EFFORT_LADDER, type Effort, type Sandbox } from "../../types.js";
import { ORCHESTRATOR_VERSION } from "../../version.js";

export function registerDiagnosticsTools(server: McpServer, ctx: AppContext): void {
  const { store, execution, ok, err } = ctx;

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
      project_mode: "per-request-git-root",
      environment,
      targets,
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

}
