import { config } from "./config.js";
import { redact } from "./runtime/redaction.js";
import type { PersistenceStore } from "./ports/persistence.js";
import type { ExecutionTarget } from "./execution/types.js";

export interface CheckRun {
  name: string;
  cmd: string;
  exit_code: number | null;
  ok: boolean;
  summary: string;
}

/**
 * Führt allowlisted Checks aus (Plan §7.10, §11). Nur Namen aus config.checks;
 * keine freien Shell-Strings. Ergebnisse werden im Store persistiert und fließen
 * in die confirm-Bedingung ein.
 */
export async function runChecks(
  store: PersistenceStore,
  clusterId: string,
  repoPath: string,
  names: string[],
  target: ExecutionTarget,
): Promise<{ runs: CheckRun[]; allGreen: boolean; unknown: string[] }> {
  const runs: CheckRun[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const spec = config.checks[name];
    if (!spec) {
      unknown.push(name);
      continue;
    }
    const result = await target.runCheck({ cwd: repoPath, argv: spec.argv });
    const code = result.code;
    const out = `${result.stdout}${result.stderr}`;
    const summary = summarizeOutput(out);
    const ok = code === 0;
    store.addCheck(clusterId, name, code, summary);
    runs.push({ name, cmd: spec.argv.join(" "), exit_code: code, ok, summary });
  }
  const allGreen = runs.length > 0 && runs.every((r) => r.ok);
  return { runs, allGreen, unknown };
}

function summarizeOutput(out: string): string {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-12).join("\n");
  return redact(tail.slice(0, 2000));
}

/**
 * Diff-Größe gegen Limits prüfen (Plan §11). Zählt getrackte Änderungen (vs HEAD)
 * UND untracked-neue Dateien, sonst würde eine reine Neu-Datei als 0 gewertet.
 */
export async function diffSize(
  repoPath: string,
  target: ExecutionTarget,
): Promise<{ files: number; lines: number }> {
  let files = 0;
  let lines = 0;
  // Getrackte Änderungen inkl. Staging (vs HEAD).
  const tracked = await target.runGit({ cwd: repoPath, argv: ["diff", "--numstat", "HEAD"], timeoutMs: 60_000 });
  for (const l of `${tracked.stdout}${tracked.stderr}`.split(/\r?\n/)) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
  }
  // Untracked-neue Dateien.
  const untracked = await target.runGit({ cwd: repoPath, argv: ["ls-files", "--others", "--exclude-standard"], timeoutMs: 60_000 });
  for (const rel of untracked.stdout.split(/\r?\n/)) {
    const name = rel.trim();
    if (!name) continue;
    files++;
    const wc = await target.runGit({ cwd: repoPath, argv: ["diff", "--numstat", "--no-index", "/dev/null", name], timeoutMs: 60_000 });
    const m = wc.stdout.match(/^(\d+|-)\t/);
    if (m && m[1] !== "-") lines += Number(m[1]);
  }
  return { files, lines };
}
