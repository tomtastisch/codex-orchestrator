import { config } from "../config.js";
import { startSlice, type RunSliceOptions, type RunningSlice } from "../codex.js";
import { buildChildEnvironment } from "../runtime/environment.js";
import { startManagedProcess } from "../runtime/process.js";
import type {
    AuthStatus,
    ExecutionTarget,
    RepositoryIdentity,
    TargetCommandRequest,
    TargetCommandResult,
    TargetHealth,
} from "./types.js";

/** @typedef LocalExecutionTargetOptions */
export interface LocalExecutionTargetOptions {
    codexBin?: string;
}

export class LocalExecutionTarget implements ExecutionTarget {
    readonly id = "local";
    readonly kind = "local" as const;
    private readonly codexBin: string;

    constructor(options: LocalExecutionTargetOptions = {}) {
        this.codexBin = options.codexBin ?? config.codexBin;
    }

    async doctor(): Promise<TargetHealth> {
        const version = await this.runBinary(this.codexBin, ["--version"], process.cwd(), 5_000, "codex");
        if (version.code !== 0) {
            return {
                targetId: this.id,
                kind: this.kind,
                state: "unhealthy",
                codexVersion: null,
                auth: { state: "unavailable", message: "Codex CLI nicht verfügbar" },
                errorCode: "TARGET_VERSION",
                message: version.stderr || "Codex CLI nicht verfügbar",
            };
        }

        const match = version.stdout.match(/(\d+\.\d+\.\d+[^\s]*)/);
        const login = await this.runBinary(this.codexBin, ["login", "status"], process.cwd(), 5_000, "codex");
        const auth = parseAuthStatus(login.code, `${login.stdout}\n${login.stderr}`);
        return {
            targetId: this.id,
            kind: this.kind,
            state: auth.state === "authenticated" ? "healthy" : "unhealthy",
            codexVersion: match?.[1] ?? null,
            auth,
            errorCode: auth.state === "authenticated" ? undefined : "TARGET_AUTH",
            message: auth.message,
        };
    }

    startCodex(request: RunSliceOptions): RunningSlice {
        return startSlice({ ...request, codexBin: this.codexBin });
    }

    async repositoryIdentity(repoPath: string): Promise<RepositoryIdentity> {
        const result = await this.runGit({
            cwd: repoPath,
            argv: ["rev-parse", "--show-toplevel", "HEAD"],
            timeoutMs: 10_000,
        });
        if (result.code !== 0) throw new Error(result.stderr || "Git-Repository nicht verfügbar");
        const [topLevel, headCommit] = result.stdout.trim().split(/\r?\n/);
        const status = await this.runGit({ cwd: repoPath, argv: ["status", "--porcelain=v1"], timeoutMs: 10_000 });
        return { topLevel, headCommit, clean: status.code === 0 && status.stdout.trim() === "" };
    }

    runCheck(request: TargetCommandRequest): Promise<TargetCommandResult> {
        const [command, ...args] = request.argv;
        return this.runBinary(command, args, request.cwd, request.timeoutMs ?? 15 * 60_000, "repository-check");
    }

    runGit(request: TargetCommandRequest): Promise<TargetCommandResult> {
        return this.runBinary("git", request.argv, request.cwd, request.timeoutMs ?? 60_000, "repository-check");
    }

    private async runBinary(
        command: string,
        args: string[],
        cwd: string,
        timeoutMs: number,
        purpose: "codex" | "repository-check",
    ): Promise<TargetCommandResult> {
        const running = startManagedProcess({
            command,
            args,
            cwd,
            env: buildChildEnvironment(process.env, purpose),
            timeoutMs,
            killGraceMs: config.limits.sliceKillGraceMs,
            maxStdoutBytes: 400_000,
            maxStderrBytes: 64_000,
        });
        const result = await running.done;
        return { code: result.code, stdout: result.stdout, stderr: result.error ?? result.stderr };
    }
}

function parseAuthStatus(code: number | null, output: string): AuthStatus {
    if (code !== 0) return { state: "unauthenticated", message: "Codex CLI ist nicht angemeldet" };
    if (/logged in using chatgpt/i.test(output)) {
        return { state: "authenticated", method: "chatgpt", message: "Codex CLI ist über ChatGPT angemeldet" };
    }
    if (/logged in using.*api/i.test(output)) {
        return { state: "authenticated", method: "api-key", message: "Codex CLI ist über API-Key angemeldet" };
    }
    return { state: "authenticated", method: "unknown", message: "Codex CLI ist angemeldet" };
}
