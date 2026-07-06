import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { parseSliceResult } from "../../events.js";
import type { RunSliceOptions, RunningSlice } from "../../codex.js";
import type { SliceOutcome } from "../../types.js";
import { TargetError } from "../errors.js";
import type {
    ExecutionTarget,
    RepositoryIdentity,
    TargetCommandRequest,
    TargetCommandResult,
    TargetErrorCode,
    TargetHealth,
} from "../types.js";
import { startWorkerProcess } from "./client.js";
import { WorkerDeployer } from "./deploy.js";
import { WORKER_PROTOCOL_VERSION, type WorkerFrame } from "./protocol.js";

/** @typedef SshExecutionTargetOptions */
export interface SshExecutionTargetOptions {
    id: string;
    host: string;
    localRoot: string;
    remoteRoot: string;
    codexBin: string;
    codexHome: string;
    workerRoot?: string;
    workerBundlePath?: string;
    workerEntry?: string;
    sshBin?: string;
    scpBin?: string;
    skipDeploy?: boolean;
}

function defaultWorkerBundle(): string {
    const directory = dirname(fileURLToPath(import.meta.url));
    const candidates = [resolve(directory, "worker.mjs"), resolve(directory, "../../../bundle/worker.mjs")];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function failedOutcome(message: string): SliceOutcome {
    return {
        threadId: null,
        agentMessages: [],
        commands: [],
        usage: null,
        sliceResult: parseSliceResult(""),
        status: "failed",
        errorMessage: message,
        rawEventCount: 0,
    };
}

export class SshExecutionTarget implements ExecutionTarget {
    readonly kind = "ssh" as const;
    readonly id: string;
    private readonly deployer?: WorkerDeployer;
    private workerEntry: string;
    private ready: boolean;

    constructor(private readonly options: SshExecutionTargetOptions) {
        this.id = options.id;
        this.workerEntry = options.workerEntry ?? "";
        this.ready = options.skipDeploy === true;
        if (!options.skipDeploy) {
            this.deployer = new WorkerDeployer({
                host: options.host,
                sshBin: options.sshBin,
                scpBin: options.scpBin,
                workerBundlePath: options.workerBundlePath ?? defaultWorkerBundle(),
                workerRoot: options.workerRoot ?? "~/.cache/codex-orchestrator",
            });
        }
    }

    mapRepository(localPath: string): string {
        const localRoot = resolve(this.options.localRoot);
        const candidate = resolve(localPath);
        const suffix = relative(localRoot, candidate);
        if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
            throw new TargetError("TARGET_REPOSITORY", "Repository-Pfad liegt außerhalb des lokalen Mappings", this.id);
        }
        return resolve(this.options.remoteRoot, suffix);
    }

    async doctor(): Promise<TargetHealth> {
        await this.prepare();
        const data = await this.invoke({
            requestId: randomUUID(),
            protocol: WORKER_PROTOCOL_VERSION,
            operation: "doctor",
            codexBin: this.options.codexBin,
            codexHome: this.options.codexHome,
        }, 20_000) as TargetHealth;
        return { ...data, targetId: this.id, kind: this.kind };
    }

    startCodex(request: RunSliceOptions): RunningSlice {
        if (!this.ready) throw new TargetError("TARGET_CONNECTIVITY", "Remote-Target wurde nicht vorbereitet", this.id, true);
        const requestId = randomUUID();
        let final: WorkerFrame | undefined;
        const process = startWorkerProcess(
            { host: this.options.host, sshBin: this.options.sshBin },
            this.workerEntry,
            {
                requestId,
                protocol: WORKER_PROTOCOL_VERSION,
                operation: "codex.run",
                allowedRoot: this.options.remoteRoot,
                cwd: this.mapRepository(request.repoPath),
                codexBin: this.options.codexBin,
                codexHome: this.options.codexHome,
                options: {
                    threadId: request.threadId,
                    prompt: request.prompt,
                    sandbox: request.sandbox,
                    model: request.model,
                    effort: request.effort,
                    network: request.network,
                    timeoutMs: request.timeoutMs,
                    extraConfig: request.extraConfig,
                },
            },
            request.timeoutMs + config.limits.sliceKillGraceMs + 15_000,
            (line) => {
                const frame = parseFrame(line);
                if (!frame || frame.requestId !== requestId) return;
                if (frame.frame === "event") request.onLine?.(frame.line);
                else final = frame;
            },
        );
        const done = process.done.then(() => {
            if (!final || final.frame !== "result") return failedOutcome("Remote-Worker lieferte kein Ergebnis");
            if (!final.ok) return failedOutcome(final.error.message);
            return final.data as SliceOutcome;
        });
        return { child: process.child, done };
    }

    async repositoryIdentity(repoPath: string): Promise<RepositoryIdentity> {
        await this.prepare();
        return this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION,
            operation: "repository.identity", allowedRoot: this.options.remoteRoot,
            cwd: this.mapRepository(repoPath),
        }, 20_000) as Promise<RepositoryIdentity>;
    }

    async runCheck(request: TargetCommandRequest): Promise<TargetCommandResult> {
        await this.prepare();
        const checkName = Object.entries(config.checks).find(([, check]) =>
            check.argv.length === request.argv.length && check.argv.every((value, index) => value === request.argv[index]))?.[0];
        if (!checkName) throw new TargetError("TARGET_POLICY", "Check ist nicht allowlisted", this.id);
        return this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION,
            operation: "check.run", allowedRoot: this.options.remoteRoot,
            cwd: this.mapRepository(request.cwd), checkName,
        }, request.timeoutMs ?? 15 * 60_000) as Promise<TargetCommandResult>;
    }

    async runGit(request: TargetCommandRequest): Promise<TargetCommandResult> {
        await this.prepare();
        return this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION,
            operation: "git.run", allowedRoot: this.options.remoteRoot,
            cwd: this.mapRepository(request.cwd), args: request.argv,
        }, request.timeoutMs ?? 60_000) as Promise<TargetCommandResult>;
    }

    async createWorktree(repoPath: string, taskId: string): Promise<{ worktree: string; branch: string }> {
        const worktree = resolve(this.options.localRoot, ".codex-orchestrator-worktrees", taskId);
        const remoteWorktree = this.mapRepository(worktree);
        const branch = `codex/${taskId}`;
        const result = await this.runGit({
            cwd: repoPath,
            argv: ["worktree", "add", "-b", branch, remoteWorktree, "HEAD"],
            timeoutMs: 60_000,
        });
        if (result.code !== 0) {
            throw new TargetError("TARGET_REPOSITORY", result.stderr || "Remote-Worktree konnte nicht erstellt werden", this.id);
        }
        return { worktree, branch };
    }

    async mergeWorktree(
        repoPath: string,
        branch: string,
        options: { noFf: boolean; noGpgSign: boolean },
    ): Promise<{ ok: boolean; conflict: boolean; output: string }> {
        const args = ["merge"];
        if (options.noFf) args.push("--no-ff");
        if (options.noGpgSign) args.push("--no-gpg-sign");
        args.push(branch);
        const result = await this.runGit({ cwd: repoPath, argv: args, timeoutMs: 120_000 });
        const output = `${result.stdout}${result.stderr}`;
        if (result.code === 0) return { ok: true, conflict: false, output };
        const conflict = /CONFLICT|automatic merge failed/i.test(output);
        if (conflict) await this.runGit({ cwd: repoPath, argv: ["merge", "--abort"], timeoutMs: 30_000 });
        return { ok: false, conflict, output };
    }

    async removeWorktree(repoPath: string, worktree: string, branch: string): Promise<void> {
        const removed = await this.runGit({
            cwd: repoPath,
            argv: ["worktree", "remove", "--force", this.mapRepository(worktree)],
            timeoutMs: 60_000,
        });
        if (removed.code !== 0) throw new TargetError("TARGET_REPOSITORY", removed.stderr, this.id);
        const deleted = await this.runGit({ cwd: repoPath, argv: ["branch", "-D", branch], timeoutMs: 30_000 });
        if (deleted.code !== 0) throw new TargetError("TARGET_REPOSITORY", deleted.stderr, this.id);
    }

    async bootstrapAuth(codexHome: string, credentials: Buffer): Promise<unknown> {
        await this.prepare();
        return this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION,
            operation: "auth.bootstrap", codexHome,
            credentialBase64: credentials.toString("base64"),
        }, 20_000);
    }

    async loginAccessToken(codexHome: string, token: Buffer): Promise<unknown> {
        await this.prepare();
        return this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION,
            operation: "auth.login-token", codexBin: this.options.codexBin,
            codexHome, tokenBase64: token.toString("base64"),
        }, 75_000);
    }

    private async prepare(): Promise<void> {
        if (this.ready) return;
        if (!this.deployer) throw new TargetError("TARGET_VERSION", "Remote-Worker-Deployer fehlt", this.id);
        this.workerEntry = await this.deployer.ensure();
        this.ready = true;
        const handshake = await this.invoke({
            requestId: randomUUID(), protocol: WORKER_PROTOCOL_VERSION, operation: "handshake",
        }, 20_000) as { protocol?: number };
        if (handshake.protocol !== WORKER_PROTOCOL_VERSION) {
            this.ready = false;
            throw new TargetError("TARGET_VERSION", "Remote-Worker-Protokoll ist inkompatibel", this.id);
        }
    }

    private async invoke(request: { requestId: string; [key: string]: unknown }, timeoutMs: number): Promise<unknown> {
        let final: WorkerFrame | undefined;
        const process = startWorkerProcess(
            { host: this.options.host, sshBin: this.options.sshBin },
            this.workerEntry,
            request,
            timeoutMs,
            (line) => {
                const frame = parseFrame(line);
                if (frame?.frame === "result" && frame.requestId === request.requestId) final = frame;
            },
        );
        const result = await process.done;
        if (!final || final.frame !== "result") {
            throw classifySshFailure(this.id, result.code, result.stderr);
        }
        if (!final.ok) throw new TargetError(parseTargetErrorCode(final.error.code), final.error.message, this.id);
        return final.data;
    }
}

const TARGET_ERROR_CODES = new Set<TargetErrorCode>([
    "TARGET_CONNECTIVITY", "TARGET_HOST_KEY", "TARGET_AUTH", "TARGET_POLICY",
    "TARGET_VERSION", "TARGET_PROTOCOL", "TARGET_REPOSITORY", "TARGET_CANCELLED", "TARGET_TIMEOUT",
]);

function parseTargetErrorCode(value: string): TargetErrorCode {
    return TARGET_ERROR_CODES.has(value as TargetErrorCode) ? value as TargetErrorCode : "TARGET_PROTOCOL";
}

function parseFrame(line: string): WorkerFrame | undefined {
    try {
        return JSON.parse(line) as WorkerFrame;
    } catch {
        return undefined;
    }
}

function classifySshFailure(targetId: string, code: number | null, stderr: string): TargetError {
    if (/host key verification failed|remote host identification has changed/i.test(stderr)) {
        return new TargetError("TARGET_HOST_KEY", "SSH-Host-Key-Prüfung fehlgeschlagen", targetId);
    }
    if (code === 255 || /timed out|connection refused|could not resolve hostname/i.test(stderr)) {
        return new TargetError("TARGET_CONNECTIVITY", "SSH-Verbindung zum Remote-Target fehlgeschlagen", targetId, true);
    }
    return new TargetError("TARGET_PROTOCOL", "Remote-Worker lieferte keine gültige Antwort", targetId);
}
