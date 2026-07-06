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

/**
 * Resolves the optional Claude Desktop repository boundary once at startup.
 * A configured value must be the canonical root of one Git working tree.
 */
export function resolveConfiguredProjectRoot(configured: string | undefined): string | null {
    if (configured === undefined) return null;
    const project = canonicalDirectory(configured, "ORCH_PROJECT_DIR");
    const git = spawnSync("git", ["-C", project, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        shell: false,
    });
    if (git.status !== 0) {
        throw new Error("ORCH_PROJECT_DIR must be a Git repository root");
    }
    const gitRoot = canonicalDirectory(git.stdout.trim(), "Git repository root");
    if (gitRoot !== project) {
        throw new Error("ORCH_PROJECT_DIR must be a Git repository root");
    }
    return project;
}

/**
 * Enforces that an operator- or model-provided repository path is exactly the
 * configured Desktop repository. Claude Code remains unrestricted when no
 * Desktop boundary is configured.
 */
export function assertProjectPathAllowed(candidate: string, configuredRoot: string | null): string {
    if (configuredRoot === null) return candidate;
    const canonical = canonicalDirectory(candidate, "repo_path");
    if (canonical !== configuredRoot) {
        throw new Error("repo_path is outside the configured project repository");
    }
    return canonical;
}
