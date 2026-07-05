import { RemoteAuthBootstrapper, type RemoteAuthStrategy } from "../auth/bootstrap.js";
import type { OrchestratorConfig } from "../config.js";
import type { RunSliceOptions, RunningSlice } from "../codex.js";
import { LocalExecutionTarget } from "./local-target.js";
import { ExecutionTargetRouter } from "./router.js";
import { SshExecutionTarget } from "./ssh/target.js";
import type {
    ExecutionTarget,
    RepositoryIdentity,
    TargetCommandRequest,
    TargetCommandResult,
    TargetHealth,
} from "./types.js";

class AuthenticatedExecutionTarget implements ExecutionTarget {
    readonly id: string;
    readonly kind: "local" | "ssh";

    constructor(
        private readonly target: SshExecutionTarget,
        private readonly strategy: RemoteAuthStrategy,
        private readonly bootstrapper = new RemoteAuthBootstrapper(),
    ) {
        this.id = target.id;
        this.kind = target.kind;
    }

    doctor(): Promise<TargetHealth> {
        return this.bootstrapper.ensure(this.target, this.strategy);
    }

    startCodex(request: RunSliceOptions): RunningSlice {
        return this.target.startCodex(request);
    }

    repositoryIdentity(repoPath: string): Promise<RepositoryIdentity> {
        return this.target.repositoryIdentity(repoPath);
    }

    runCheck(request: TargetCommandRequest): Promise<TargetCommandResult> {
        return this.target.runCheck(request);
    }

    runGit(request: TargetCommandRequest): Promise<TargetCommandResult> {
        return this.target.runGit(request);
    }

    createWorktree(repoPath: string, taskId: string): Promise<{ worktree: string; branch: string }> {
        return this.target.createWorktree(repoPath, taskId);
    }

    mergeWorktree(repoPath: string, branch: string, options: { noFf: boolean; noGpgSign: boolean }) {
        return this.target.mergeWorktree(repoPath, branch, options);
    }

    removeWorktree(repoPath: string, worktree: string, branch: string): Promise<void> {
        return this.target.removeWorktree(repoPath, worktree, branch);
    }
}

export class ExecutionTargetRegistry {
    private readonly targets = new Map<string, ExecutionTarget>();

    register(target: ExecutionTarget): void {
        this.targets.set(target.id, target);
    }

    get(id: string): ExecutionTarget {
        const target = this.targets.get(id);
        if (!target) throw new Error(`Unbekanntes Execution-Target: ${id}`);
        return target;
    }

    list(): ExecutionTarget[] {
        return [...this.targets.values()];
    }
}

/** Creates the fail-closed target registry and router from validated server configuration. */
export function createExecutionRuntime(configuration: OrchestratorConfig): {
    registry: ExecutionTargetRegistry;
    router: ExecutionTargetRouter;
} {
    const registry = new ExecutionTargetRegistry();
    const local = new LocalExecutionTarget({ codexBin: configuration.codexBin });
    registry.register(local);
    let remote: ExecutionTarget | undefined;

    if (configuration.execution.mode !== "local-only") {
        const remoteConfig = configuration.execution.remote;
        const raw = new SshExecutionTarget({
            id: remoteConfig.id,
            host: remoteConfig.host,
            localRoot: remoteConfig.repository.localRoot,
            remoteRoot: remoteConfig.repository.remoteRoot,
            codexBin: remoteConfig.codexBin,
            workerRoot: remoteConfig.workerRoot,
        });
        const strategy: RemoteAuthStrategy = remoteConfig.auth.strategy === "existing"
            ? remoteConfig.auth
            : { ...remoteConfig.auth, codexHome: remoteConfig.codexHome };
        remote = new AuthenticatedExecutionTarget(raw, strategy);
        registry.register(remote);
    }

    return {
        registry,
        router: new ExecutionTargetRouter({
            mode: configuration.execution.mode,
            fallback: configuration.execution.fallback,
            local,
            remote,
        }),
    };
}
