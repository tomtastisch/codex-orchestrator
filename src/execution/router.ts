import { TargetError } from "./errors.js";
import type { ExecutionTarget, RepositoryIdentity, TargetHealth } from "./types.js";

/** @typedef ExecutionTargetRouterOptions */
export interface ExecutionTargetRouterOptions {
    mode: "local-only" | "remote-only" | "remote-preferred";
    fallback: "never" | "connectivity-only";
    local: ExecutionTarget;
    remote?: ExecutionTarget;
}

/** @typedef TargetSelection */
export interface TargetSelection {
    target: ExecutionTarget;
    repository: RepositoryIdentity;
    reason: "local-only" | "remote-healthy" | "remote-connectivity-fallback";
    fallbackFrom: string | null;
}

function healthError(health: TargetHealth): TargetError {
    const code = health.errorCode ?? (health.auth.state === "authenticated" ? "TARGET_VERSION" : "TARGET_AUTH");
    return new TargetError(code, health.message, health.targetId, false);
}

export class ExecutionTargetRouter {
    constructor(private readonly options: ExecutionTargetRouterOptions) {}

    async select(repoPath: string): Promise<TargetSelection> {
        if (this.options.mode === "local-only") {
            const repository = await this.requireHealthy(this.options.local, repoPath);
            return { target: this.options.local, repository, reason: "local-only", fallbackFrom: null };
        }

        const remote = this.options.remote;
        if (!remote) throw new TargetError("TARGET_POLICY", "Remote-Ausführung ist nicht konfiguriert", "remote");
        try {
            const remoteRepository = await this.requireHealthy(remote, repoPath);
            const localRepository = await this.requireHealthy(this.options.local, repoPath);
            this.requireMatchingRepositories(localRepository, remoteRepository, remote.id);
            return { target: remote, repository: remoteRepository, reason: "remote-healthy", fallbackFrom: null };
        } catch (error) {
            const targetError = error instanceof TargetError
                ? error
                : new TargetError("TARGET_PROTOCOL", error instanceof Error ? error.message : String(error), remote.id);
            const canFallback = this.options.mode === "remote-preferred"
                && this.options.fallback === "connectivity-only"
                && targetError.code === "TARGET_CONNECTIVITY"
                && targetError.retryable;
            if (!canFallback) throw targetError;

            const repository = await this.requireHealthy(this.options.local, repoPath);
            if (!repository.clean) {
                throw new TargetError("TARGET_REPOSITORY", "Lokales Fallback-Repository enthält uncommittierte Änderungen", "local");
            }
            return {
                target: this.options.local,
                repository,
                reason: "remote-connectivity-fallback",
                fallbackFrom: remote.id,
            };
        }
    }

    private async requireHealthy(target: ExecutionTarget, repoPath: string): Promise<RepositoryIdentity> {
        const health = await target.doctor();
        if (health.state !== "healthy") throw healthError(health);
        return target.repositoryIdentity(repoPath);
    }

    private requireMatchingRepositories(
        local: RepositoryIdentity,
        remote: RepositoryIdentity,
        remoteTargetId: string,
    ): void {
        if (local.headCommit !== remote.headCommit) {
            throw new TargetError("TARGET_REPOSITORY", "Lokaler und entfernter Git-Commit stimmen nicht überein", remoteTargetId);
        }
        if (!local.clean || !remote.clean) {
            throw new TargetError("TARGET_REPOSITORY", "Remote-Routing erfordert saubere Repository-Zustände", remoteTargetId);
        }
    }
}
