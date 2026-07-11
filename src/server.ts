#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync as _existsSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync, mkdirSync as _mkdirSync } from "node:fs";
import { join as _join } from "node:path";
import { config } from "./config.js";
import { isProcessAlive } from "./session.js";
import { ORCHESTRATOR_VERSION } from "./version.js";
import { createAppContext } from "./app/context.js";
import { registerPrompts } from "./app/prompts.js";
import { registerDiagnosticsTools } from "./app/tools/diagnostics.js";
import { registerTaskTools } from "./app/tools/tasks.js";
import { registerPlanningTools } from "./app/tools/planning.js";
import { registerKnowledgeTools } from "./app/tools/knowledge.js";

// Composition root: this module contains no business logic. It builds the
// application context (the singleton graph), wires the tool/prompt modules onto
// the MCP server, and manages process lifecycle. All tool behaviour lives in the
// application layer under src/app/.
const ctx = createAppContext();

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
const reaped = ctx.sessions.reapOnStartup();
if (reaped > 0) console.error(`[orchestrator] Reaper: ${reaped} verwaiste Task(s) toter Prozesse auf 'failed' gesetzt.`);

const server = new McpServer({ name: "codex-orchestrator", version: ORCHESTRATOR_VERSION });

registerPrompts(server);
registerDiagnosticsTools(server, ctx);
registerTaskTools(server, ctx);
registerPlanningTools(server, ctx);
registerKnowledgeTools(server, ctx);

// F: Graceful Shutdown — laufende Codex-Kinder terminieren, instance.json aufräumen.
let shuttingDown = false;
function gracefulShutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const n = ctx.sessions.shutdown();
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
