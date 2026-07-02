import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

/** git-Aufruf ohne Shell; wirft bei Fehler mit stderr. */
function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} fehlgeschlagen: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

export function isGitRepo(repoPath: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

/**
 * Worktree Manager (Plan §10). Jeder parallele Task erhält ein isoliertes
 * git worktree auf eigenem Branch. Merge erfolgt sequenziell nach Review.
 */
export class WorktreeManager {
  constructor(private root = config.worktreeRoot) {
    mkdirSync(this.root, { recursive: true });
  }

  create(repoPath: string, taskId: string, baseBranch?: string): { worktree: string; branch: string } {
    if (!isGitRepo(repoPath)) {
      throw new Error(`Kein git-Repo: ${repoPath}. Worktree-Isolation nicht möglich.`);
    }
    const branch = `orch/${taskId}`;
    const worktree = resolve(this.root, taskId);
    if (existsSync(worktree)) {
      return { worktree, branch };
    }
    // Basis = angegebener Branch oder aktueller HEAD (weglassen -> git nimmt HEAD).
    const args = ["worktree", "add", "-b", branch, worktree];
    if (baseBranch) args.push(baseBranch);
    git(repoPath, args);
    return { worktree, branch };
  }

  /** Merge des Subtask-Branches zurück (sequenziell, nach Review). */
  merge(repoPath: string, branch: string, opts?: { noFf?: boolean; noGpgSign?: boolean }): { ok: boolean; conflict: boolean; output: string } {
    const args = ["merge", opts?.noFf ? "--no-ff" : "--ff"];
    if (opts?.noGpgSign) args.push("--no-gpg-sign");
    args.push(branch);
    const r = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
    const output = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0) return { ok: true, conflict: false, output };
    const conflict = /conflict/i.test(output);
    if (conflict) {
      // Merge abbrechen, damit das Repo sauber bleibt; Reparatur-Slice entscheidet Claude.
      spawnSync("git", ["merge", "--abort"], { cwd: repoPath });
    }
    return { ok: false, conflict, output };
  }

  /** Worktree entfernen (Aufräumen). Bei Cancel bewusst NICHT automatisch. */
  remove(repoPath: string, worktree: string, deleteBranch?: string): void {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoPath });
    if (deleteBranch) spawnSync("git", ["branch", "-D", deleteBranch], { cwd: repoPath });
  }

  list(repoPath: string): string {
    return git(repoPath, ["worktree", "list"]);
  }
}
