import { config } from "../../config.js";
import { buildChildEnvironment } from "../../runtime/environment.js";
import { startManagedProcess, type RunningManagedProcess } from "../../runtime/process.js";

/** @typedef SshClientOptions */
export interface SshClientOptions {
    host: string;
    sshBin?: string;
    connectTimeoutSeconds?: number;
}

export function sshOptions(options: SshClientOptions): string[] {
    return [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`,
    ];
}

export function startWorkerProcess(
    options: SshClientOptions,
    workerEntry: string,
    request: unknown,
    timeoutMs: number,
    onLine?: (line: string) => void,
): RunningManagedProcess {
    return startManagedProcess({
        command: options.sshBin ?? "ssh",
        args: [...sshOptions(options), options.host, "node", workerEntry],
        env: buildChildEnvironment(process.env, "ssh"),
        input: JSON.stringify(request),
        timeoutMs,
        killGraceMs: config.limits.sliceKillGraceMs,
        maxStdoutBytes: 12 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        onStdoutLine: onLine,
    });
}
