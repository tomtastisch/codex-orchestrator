import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";
import { parseSliceResult, parseStreamLines } from "./events.js";
import { buildChildEnvironment } from "./runtime/environment.js";
import { startManagedProcess } from "./runtime/process.js";
import type { Effort, Sandbox, SliceOutcome } from "./types.js";

export interface RunSliceOptions {
  /** Target-specific Codex binary. Defaults to the local configured binary. */
  codexBin?: string;
  /** Target-specific persistent Codex home. */
  codexHome?: string;
  repoPath: string;
  /** Wenn gesetzt: resume dieses Threads statt Neustart. */
  threadId?: string | null;
  prompt: string;
  sandbox: Sandbox;
  model: string;
  effort: Effort;
  network: boolean;
  /** Zusätzliche `-c key=value`-Overrides pro Task (sicherheitskritische Keys gesperrt). */
  extraConfig?: Record<string, string>;
  /** Hartes Budget: nach Ablauf SIGTERM, dann SIGKILL. */
  timeoutMs: number;
  /** Externer Abbruch (task_control cancel). */
  signal?: AbortSignal;
  /** Callback pro roher JSONL-Zeile (für Live-Persistenz der Events). */
  onLine?: (line: string) => void;
}

/** Vom Server verwaltete Keys: exakt gesperrt (per extra_config nicht überschreibbar). */
export const BLOCKED_CONFIG_KEYS = new Set([
  "model",
  "model_reasoning_effort",
  "notify",
  "approval_policy",
]);
/**
 * Ganze Config-Kategorien sperren, die Prozess-/MCP-/Umgebungs-/Trust-Injektion
 * ermöglichen würden. Blocklist bewusst breit (fail-closed): eine per
 * extra_config gesetzte `mcp_servers.*`/`hooks`/`shell_environment_policy.*`
 * wäre sonst faktisch Remote Code Execution im Codex-Run.
 */
export const BLOCKED_CONFIG_PREFIXES = [
  "sandbox",                    // sandbox_mode, sandbox_permissions, sandbox_workspace_write.*
  "mcp_servers",                // beliebige MCP-Server / Prozesse starten
  "shell_environment_policy",   // Umgebungsvariablen/Secrets durchreichen
  "hooks",                      // beliebige Kommandos ausführen
  "projects",                   // Trust-Level / Freigaben
  "trust",
  "history",
  "experimental",
  "features",                   // Feature-Flags server-seitig kontrolliert
];

const ALLOWED_EXTRA_CONFIG = new Map<string, RegExp>([
  ["model_verbosity", /^(low|medium|high|concise)$/],
  ["model_reasoning_summary", /^(none|auto|concise|detailed)$/],
  ["hide_agent_reasoning", /^(true|false)$/],
]);

export function isBlockedConfigKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k || /[\s=]/.test(k)) return true;                 // ungültige/mehrdeutige Keys
  if (k.includes("danger")) return true;
  if (BLOCKED_CONFIG_KEYS.has(k)) return true;
  return BLOCKED_CONFIG_PREFIXES.some((p) => k === p || k.startsWith(p + ".") || k.startsWith(p + "_"));
}

export function validateExtraConfig(key: string, value: string): void {
  const normalized = key.trim().toLowerCase();
  const valueSchema = ALLOWED_EXTRA_CONFIG.get(normalized);
  if (!valueSchema) {
    throw new Error(`extra_config-Schlüssel '${key}' ist nicht erlaubt`);
  }
  if (!valueSchema.test(value.trim())) {
    throw new Error(`extra_config-Wert für '${key}' ist nicht erlaubt`);
  }
}

/**
 * Baut die codex-Argumentliste (ohne Binary). Rein & testbar.
 * Jede Sicherheits-/Modell-/Effort-Einstellung wird hier deterministisch gesetzt.
 */
export function buildCodexArgs(opts: {
  threadId?: string | null;
  sandbox: Sandbox;
  model: string;
  effort: Effort;
  network: boolean;
  extraConfig?: Record<string, string>;
}): { args: string[]; droppedConfigKeys: string[] } {
  const dropped: string[] = [];
  const cfg: string[] = [
    "-c", `sandbox_mode=${opts.sandbox}`,
    "-c", `model=${opts.model}`,
    "-c", `model_reasoning_effort=${opts.effort}`,
    "-c", "notify=[]",
    "-c", `sandbox_workspace_write.network_access=${opts.network ? "true" : "false"}`,
  ];
  for (const [key, value] of Object.entries(opts.extraConfig ?? {})) {
    if (isBlockedConfigKey(key)) { dropped.push(key); continue; }
    validateExtraConfig(key, value);
    cfg.push("-c", `${key}=${value}`);
  }
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", ...cfg];
  const args = opts.threadId
    ? ["exec", "resume", opts.threadId, ...common, "-"]
    : ["exec", ...common, "-"];
  return { args, droppedConfigKeys: dropped };
}

export interface RunningSlice {
  child: ChildProcessWithoutNullStreams;
  done: Promise<SliceOutcome>;
}

/**
 * Führt einen einzelnen Codex-Slice aus. danger-full-access ist strukturell
 * unerreichbar: sandbox ist auf read-only|workspace-write typisiert und wird
 * hier nochmals geprüft (fail-closed).
 */
export function startSlice(opts: RunSliceOptions): RunningSlice {
  if (!config.allowedSandboxes.includes(opts.sandbox)) {
    throw new Error(`Sandbox nicht erlaubt: ${opts.sandbox}`);
  }

  const { args } = buildCodexArgs(opts);

  const lines: string[] = [];
  const childEnvironment = buildChildEnvironment(process.env, "codex");
  if (opts.codexHome) childEnvironment.CODEX_HOME = opts.codexHome;
  const managed = startManagedProcess({
    command: opts.codexBin ?? config.codexBin,
    args,
    cwd: opts.repoPath,
    env: childEnvironment,
    input: opts.prompt,
    timeoutMs: opts.timeoutMs,
    killGraceMs: config.limits.sliceKillGraceMs,
    maxStdoutBytes: 10 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    signal: opts.signal,
    onStdoutLine: (line) => {
      lines.push(line);
      if (lines.length > 10_000) lines.shift();
      opts.onLine?.(line);
    },
  });

  const done = managed.done.then((processResult): SliceOutcome => {
      const parsed = parseStreamLines(lines);
      const lastMsg = parsed.agentMessages[parsed.agentMessages.length - 1] ?? "";
      const sliceResult = parseSliceResult(lastMsg);

      let status: SliceOutcome["status"] = "normal";
      let errorMessage: string | null = null;

      if (processResult.termination === "aborted") {
        status = "killed";
        errorMessage = "abgebrochen (cancel)";
      } else if (processResult.termination === "timeout") {
        status = "killed";
        errorMessage = "Slice-Budget überschritten (killed)";
      } else if (processResult.termination === "output_limit") {
        status = "failed";
        errorMessage = "Codex-Ausgabe überschritt das Sicherheitslimit";
      } else if (processResult.termination === "spawn_error") {
        status = "failed";
        errorMessage = `Prozessfehler: ${processResult.error ?? "unbekannter Fehler"}`;
      } else if (parsed.turnFailed || parsed.errorMessage) {
        status = "failed";
        errorMessage =
          parsed.errorMessage ||
          `Codex-Fehler (exit ${processResult.code}). stderr: ${processResult.stderr.slice(-500)}`;
      } else if (processResult.code !== 0 && parsed.rawEventCount === 0) {
        status = "failed";
        errorMessage = `codex exit ${processResult.code}. stderr: ${processResult.stderr.slice(-500)}`;
      }

      return {
        threadId: parsed.threadId ?? opts.threadId ?? null,
        agentMessages: parsed.agentMessages,
        commands: parsed.commands,
        usage: parsed.usage,
        sliceResult,
        status,
        errorMessage,
        rawEventCount: parsed.rawEventCount,
      };
  });

  return { child: managed.child, done };
}

export function runSlice(opts: RunSliceOptions): Promise<SliceOutcome> {
  return startSlice(opts).done;
}
