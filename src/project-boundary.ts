import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

function canonicalDirectory(path: string, variable: string): string {
    if (!isAbsolute(path)) {
        throw new Error(`${variable} must be an absolute path`);
    }
    try {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory()) {
            throw new Error(`${variable} must be a directory`);
        }
        return canonical;
    } catch (error) {
        if (error instanceof Error && error.message === `${variable} must be a directory`) {
            throw error;
        }
        throw new Error(`${variable} must be a directory`);
    }
}

/** Resolves and validates one repository path supplied for an orchestration request. */
export function assertGitRepositoryRoot(candidate: string): string {
    const project = canonicalDirectory(candidate, "repo_path");
    const git = spawnSync("git", ["-C", project, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        shell: false,
    });
    if (git.status !== 0) {
        throw new Error("repo_path must be a Git repository root");
    }
    const gitRoot = canonicalDirectory(git.stdout.trim(), "Git repository root");
    if (gitRoot !== project) {
        throw new Error("repo_path must be a Git repository root");
    }
    return project;
}
