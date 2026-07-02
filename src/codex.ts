import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { config } from "./config.js";
import { parseSliceResult, parseStreamLines } from "./events.js";
import type { Effort, Sandbox, SliceOutcome } from "./types.js";

export interface RunSliceOptions {
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
export function isBlockedConfigKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k || /[\s=]/.test(k)) return true;                 // ungültige/mehrdeutige Keys
  if (k.includes("danger")) return true;
  if (BLOCKED_CONFIG_KEYS.has(k)) return true;
  return BLOCKED_CONFIG_PREFIXES.some((p) => k === p || k.startsWith(p + ".") || k.startsWith(p + "_"));
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

  const child = spawn(config.codexBin, args, {
    cwd: opts.repoPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  // Prompt über stdin (vermeidet argv-Längenlimits und Quoting-Probleme).
  child.stdin.write(opts.prompt);
  child.stdin.end();

  const lines: string[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    lines.push(line);
    opts.onLine?.(line);
  });
  let stderrBuf = "";
  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-200_000);
  });

  let killedByBudget = false;
  let killedByCancel = false;

  const killTimer = setTimeout(() => {
    killedByBudget = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, config.limits.sliceKillGraceMs);
  }, opts.timeoutMs);

  const onAbort = () => {
    killedByCancel = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, config.limits.sliceKillGraceMs);
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const done = new Promise<SliceOutcome>((resolvePromise) => {
    child.on("close", (code) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);

      const parsed = parseStreamLines(lines);
      const lastMsg = parsed.agentMessages[parsed.agentMessages.length - 1] ?? "";
      const sliceResult = parseSliceResult(lastMsg);

      let status: SliceOutcome["status"] = "normal";
      let errorMessage: string | null = null;

      if (killedByCancel) {
        status = "killed";
        errorMessage = "abgebrochen (cancel)";
      } else if (killedByBudget) {
        status = "killed";
        errorMessage = "Slice-Budget überschritten (killed)";
      } else if (parsed.turnFailed || parsed.errorMessage) {
        status = "failed";
        errorMessage =
          parsed.errorMessage ||
          `Codex-Fehler (exit ${code}). stderr: ${stderrBuf.slice(-500)}`;
      } else if (code !== 0 && parsed.rawEventCount === 0) {
        status = "failed";
        errorMessage = `codex exit ${code}. stderr: ${stderrBuf.slice(-500)}`;
      }

      resolvePromise({
        threadId: parsed.threadId ?? opts.threadId ?? null,
        agentMessages: parsed.agentMessages,
        commands: parsed.commands,
        usage: parsed.usage,
        sliceResult,
        status,
        errorMessage,
        rawEventCount: parsed.rawEventCount,
      });
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolvePromise({
        threadId: opts.threadId ?? null,
        agentMessages: [],
        commands: [],
        usage: null,
        sliceResult: parseSliceResult(""),
        status: "failed",
        errorMessage: `Prozessfehler: ${err.message}`,
        rawEventCount: 0,
      });
    });
  });

  return { child, done };
}

export function runSlice(opts: RunSliceOptions): Promise<SliceOutcome> {
  return startSlice(opts).done;
}
