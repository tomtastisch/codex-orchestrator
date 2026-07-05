import type { RunSliceOptions, RunningSlice } from "../codex.js";

/** @typedef TargetErrorCode */
export type TargetErrorCode =
    | "TARGET_CONNECTIVITY"
    | "TARGET_HOST_KEY"
    | "TARGET_AUTH"
    | "TARGET_POLICY"
    | "TARGET_VERSION"
    | "TARGET_PROTOCOL"
    | "TARGET_REPOSITORY"
    | "TARGET_CANCELLED"
    | "TARGET_TIMEOUT";

/** @typedef AuthStatus */
export interface AuthStatus {
    state: "authenticated" | "unauthenticated" | "unavailable" | "error";
    method?: "chatgpt" | "api-key" | "access-token" | "unknown";
    message: string;
}

/** @typedef TargetHealth */
export interface TargetHealth {
    targetId: string;
    kind: "local" | "ssh";
    state: "healthy" | "unhealthy";
    codexVersion: string | null;
    auth: AuthStatus;
    errorCode?: TargetErrorCode;
    message: string;
}

/** @typedef RepositoryIdentity */
export interface RepositoryIdentity {
    topLevel: string;
    headCommit: string;
    clean: boolean;
}

/** @typedef TargetCommandRequest */
export interface TargetCommandRequest {
    cwd: string;
    argv: string[];
    timeoutMs?: number;
}

/** @typedef TargetCommandResult */
export interface TargetCommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** @typedef ExecutionTarget */
export interface ExecutionTarget {
    readonly id: string;
    readonly kind: "local" | "ssh";
    doctor(): Promise<TargetHealth>;
    startCodex(request: RunSliceOptions): RunningSlice;
    repositoryIdentity(repoPath: string): Promise<RepositoryIdentity>;
    runCheck(request: TargetCommandRequest): Promise<TargetCommandResult>;
    runGit(request: TargetCommandRequest): Promise<TargetCommandResult>;
}
