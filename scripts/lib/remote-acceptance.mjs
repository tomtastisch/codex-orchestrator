import { spawn } from "node:child_process";
import { accessSync, constants, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";

/** @typedef {{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string}} CommandResult */

/** Resolve an executable without invoking a shell. */
export function findBinary(name, pathValue = process.env.PATH || "") {
    const candidates = isAbsolute(name)
        ? [name]
        : pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, name));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Continue with the next PATH entry.
        }
    }
    throw new Error(`Erforderliches Binary nicht gefunden: ${name}`);
}

/** Resolve the local Codex credential source before HOME is isolated for SSH. */
export function resolveCodexAuthSource(environment, userHome) {
    return join(environment.CODEX_HOME || join(userHome, ".codex"), "auth.json");
}

/** Ask the kernel for a currently free non-privileged loopback port. */
export async function allocateLoopbackPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port <= 1024) throw new Error(`Ungültiger ephemerer Port: ${port}`);
    return port;
}

/** Retry a readiness probe without fixed sleeps in the successful path. */
export async function retryUntilSuccess(operation, options = {}) {
    const attempts = options.attempts ?? 20;
    const delayMs = options.delayMs ?? 100;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt + 1 < attempts) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Readiness-Probe fehlgeschlagen");
}

/** Run an argv-only command with bounded output and deterministic timeout. */
export function runCommand(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const append = (current, chunk) => `${current}${chunk}`.slice(-256 * 1024);
        child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        child.once("error", reject);
        if (options.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function waitForClose(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, timeoutMs);
        child.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** Owns only acceptance-test children and its disposable temporary root. */
export class AcceptanceCleanup {
    #children = [];
    #done = false;

    constructor(root) {
        this.root = root;
    }

    track(child) {
        this.#children.push(child);
        return child;
    }

    async run() {
        if (this.#done) return;
        this.#done = true;
        for (const child of this.#children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }
        await Promise.all(this.#children.map((child) => waitForClose(child, 2_000)));
        rmSync(this.root, { recursive: true, force: true });
    }
}
