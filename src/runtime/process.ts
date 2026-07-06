import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redact } from "./redaction.js";

/** @typedef ManagedTermination */
export type ManagedTermination = "normal" | "timeout" | "aborted" | "output_limit" | "spawn_error";

/** @typedef ManagedProcessOptions */
export interface ManagedProcessOptions {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
    input?: string | Buffer;
    timeoutMs: number;
    killGraceMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    signal?: AbortSignal;
    onStdoutLine?: (line: string) => void;
}

/** @typedef ManagedProcessResult */
export interface ManagedProcessResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    termination: ManagedTermination;
    stdout: string;
    stderr: string;
    error?: string;
}

/** @typedef RunningManagedProcess */
export interface RunningManagedProcess {
    child: ChildProcessWithoutNullStreams;
    done: Promise<ManagedProcessResult>;
}

/** @typedef ManagedCommand */
export interface ManagedCommand {
    command: string;
    args: string[];
}

/**
 * Resolve JavaScript executables without relying on POSIX shebang handling.
 * This keeps argv shell-free and makes bundled/test launchers portable to Windows.
 */
export function resolveManagedCommand(
    command: string,
    args: string[],
    platform: NodeJS.Platform = process.platform,
): ManagedCommand {
    if (platform === "win32" && /\.(?:c|m)?js$/i.test(command)) {
        return { command: process.execPath, args: [command, ...args] };
    }
    return { command, args };
}

function appendBounded(current: string, chunk: Buffer, maximum: number): { value: string; exceeded: boolean } {
    const next = current + chunk.toString();
    if (Buffer.byteLength(next) <= maximum) return { value: next, exceeded: false };
    return { value: next.slice(-maximum), exceeded: true };
}

/** Starts a child with deterministic timeout, abort and output-limit handling. */
export function startManagedProcess(options: ManagedProcessOptions): RunningManagedProcess {
    const resolved = resolveManagedCommand(options.command, options.args);
    const child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let termination: ManagedTermination = "normal";
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = (reason: ManagedTermination): void => {
        if (termination === "normal") termination = reason;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        forceKillTimer ??= setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, options.killGraceMs);
    };

    child.stdout.on("data", (chunk: Buffer) => {
        const appended = appendBounded(stdout, chunk, options.maxStdoutBytes);
        stdout = appended.value;
        lineBuffer += chunk.toString();
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0) {
            options.onStdoutLine?.(lineBuffer.slice(0, newline));
            lineBuffer = lineBuffer.slice(newline + 1);
            newline = lineBuffer.indexOf("\n");
        }
        if (appended.exceeded) terminate("output_limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
        const appended = appendBounded(stderr, chunk, options.maxStderrBytes);
        stderr = appended.value;
        if (appended.exceeded) terminate("output_limit");
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = () => terminate("aborted");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const done = new Promise<ManagedProcessResult>((resolve) => {
        const finish = (result: ManagedProcessResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };

        child.on("close", (code, signal) => {
            if (lineBuffer) options.onStdoutLine?.(lineBuffer);
            finish({
                code,
                signal,
                termination,
                stdout,
                stderr: redact(stderr),
            });
        });
        child.on("error", (error) => {
            termination = "spawn_error";
            finish({
                code: null,
                signal: null,
                termination,
                stdout,
                stderr: redact(stderr),
                error: redact(error.message),
            });
        });
    });

    return { child, done };
}
