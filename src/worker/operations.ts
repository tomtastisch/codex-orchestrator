import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { config } from "../config.js";
import { LocalExecutionTarget } from "../execution/local-target.js";
import { parseWorkerRequest, WORKER_PROTOCOL_VERSION, type WorkerRequest } from "../execution/ssh/protocol.js";
import { buildChildEnvironment } from "../runtime/environment.js";
import { startManagedProcess } from "../runtime/process.js";
import { ORCHESTRATOR_VERSION } from "../version.js";
import { assertAllowedPath } from "./path-policy.js";

function resolveCodexHome(value: string): string {
    if (value === "~") return homedir();
    if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
    if (!isAbsolute(value)) throw new Error("codexHome muss absolut sein oder mit ~/ beginnen");
    return resolve(value);
}

function bootstrapAuth(
    codexHomeValue: string,
    credentialBase64: string,
): { state: "installed" | "already_present" | "updated" } {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(credentialBase64)) throw new Error("Credential-Payload ist kein gültiges Base64");
    const credentials = Buffer.from(credentialBase64, "base64");
    if (credentials.length === 0 || credentials.length > 64 * 1024) {
        throw new Error("Credential-Payload muss zwischen 1 Byte und 64 KiB groß sein");
    }

    try {
        const codexHome = resolveCodexHome(codexHomeValue);
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") chmodSync(codexHome, 0o700);
        const destination = join(codexHome, "auth.json");
        let replacing = false;
        if (existsSync(destination)) {
            const metadata = lstatSync(destination);
            if (metadata.isSymbolicLink() || !metadata.isFile()) {
                throw new Error("Remote auth.json muss eine reguläre Datei und darf kein Symlink sein");
            }
            if (readFileSync(destination).equals(credentials)) {
                if (process.platform !== "win32") chmodSync(destination, 0o600);
                return { state: "already_present" };
            }
            replacing = true;
        }

        const temporary = join(codexHome, `.auth.json.${process.pid}.${Date.now()}.tmp`);
        let descriptor: number | undefined;
        try {
            descriptor = openSync(temporary, "wx", 0o600);
            writeSync(descriptor, credentials);
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temporary, destination);
            return { state: replacing ? "updated" : "installed" };
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    } finally {
        credentials.fill(0);
    }
}

async function loginAccessToken(
    codexBin: string,
    codexHomeValue: string,
    tokenBase64: string,
): Promise<{ state: "installed" }> {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(tokenBase64)) throw new Error("Token-Payload ist kein gültiges Base64");
    const token = Buffer.from(tokenBase64, "base64");
    if (token.length === 0 || token.length > 64 * 1024) {
        throw new Error("Token-Payload muss zwischen 1 Byte und 64 KiB groß sein");
    }
    const environment = buildChildEnvironment(process.env, "codex");
    environment.CODEX_HOME = resolveCodexHome(codexHomeValue);
    const processResult = await startManagedProcess({
        command: codexBin,
        args: ["login", "--with-access-token"],
        env: environment,
        input: token,
        timeoutMs: 60_000,
        killGraceMs: 2_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
    }).done;
    token.fill(0);
    if (processResult.code !== 0) {
        throw new Error(`Codex-Token-Login fehlgeschlagen: ${processResult.stderr || processResult.error || "unbekannter Fehler"}`);
    }
    return { state: "installed" };
}

export async function executeWorkerRequest(
    input: WorkerRequest | unknown,
    onEvent: (line: string) => void = () => {},
): Promise<unknown> {
    const request = parseWorkerRequest(input);
    switch (request.operation) {
        case "handshake":
            return {
                protocol: WORKER_PROTOCOL_VERSION,
                workerVersion: ORCHESTRATOR_VERSION,
                nodeVersion: process.versions.node,
                platform: process.platform,
                architecture: process.arch,
            };
        case "doctor":
            return new LocalExecutionTarget({
                codexBin: request.codexBin,
                codexHome: resolveCodexHome(request.codexHome),
            }).doctor();
        case "auth.status": {
            const health = await new LocalExecutionTarget({
                codexBin: request.codexBin,
                codexHome: resolveCodexHome(request.codexHome),
            }).doctor();
            return health.auth;
        }
        case "auth.bootstrap":
            return bootstrapAuth(request.codexHome, request.credentialBase64);
        case "auth.login-token":
            return loginAccessToken(request.codexBin, request.codexHome, request.tokenBase64);
        case "repository.identity": {
            const cwd = assertAllowedPath(request.allowedRoot, request.cwd);
            return new LocalExecutionTarget().repositoryIdentity(cwd);
        }
        case "check.run": {
            const cwd = assertAllowedPath(request.allowedRoot, request.cwd);
            const check = config.checks[request.checkName];
            if (!check) throw new Error(`Unbekannter Check: ${request.checkName}`);
            return new LocalExecutionTarget().runCheck({ cwd, argv: check.argv });
        }
        case "git.run": {
            const cwd = assertAllowedPath(request.allowedRoot, request.cwd);
            return new LocalExecutionTarget().runGit({ cwd, argv: request.args });
        }
        case "codex.run": {
            const cwd = assertAllowedPath(request.allowedRoot, request.cwd);
            const target = new LocalExecutionTarget({
                codexBin: request.codexBin,
                codexHome: resolveCodexHome(request.codexHome),
            });
            const running = target.startCodex({
                repoPath: cwd,
                threadId: request.options.threadId,
                prompt: request.options.prompt,
                sandbox: request.options.sandbox,
                model: request.options.model,
                effort: request.options.effort,
                network: request.options.network,
                timeoutMs: request.options.timeoutMs,
                extraConfig: request.options.extraConfig,
                onLine: onEvent,
            });
            return running.done;
        }
    }
}
