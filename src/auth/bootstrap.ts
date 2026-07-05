import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TargetError } from "../execution/errors.js";
import type { TargetHealth } from "../execution/types.js";
import { buildChildEnvironment } from "../runtime/environment.js";
import { startManagedProcess } from "../runtime/process.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** @typedef RemoteAuthStrategy */
export type RemoteAuthStrategy =
    | { strategy: "existing" }
    | { strategy: "sync-file"; source?: string; codexHome?: string }
    | { strategy: "access-token"; secretCommand: string[]; codexHome?: string };

/** @typedef RemoteAuthTarget */
export interface RemoteAuthTarget {
    readonly id: string;
    doctor(): Promise<TargetHealth>;
    bootstrapAuth?(codexHome: string, credentials: Buffer): Promise<unknown>;
    loginAccessToken?(codexHome: string, token: Buffer): Promise<unknown>;
}

/**
 * Reads a local credential file only when it is a private, owner-controlled regular file.
 */
export function loadCredentialFile(path: string): Buffer {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Credential-Quelle muss eine reguläre Datei und darf kein Symlink sein");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("Credential-Quelle muss dem aktuellen Benutzer gehören");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error("Credential-Quelle benötigt private Rechte (0600)");
    }
    if (metadata.size < 1 || metadata.size > MAX_CREDENTIAL_BYTES) {
        throw new Error("Credential-Quelle muss zwischen 1 Byte und 64 KiB groß sein");
    }
    return readFileSync(path);
}

function defaultCredentialSource(): string {
    return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

function requireHealthy(health: TargetHealth, targetId: string): TargetHealth {
    if (health.state === "healthy" && health.auth.state === "authenticated") return health;
    throw new TargetError(
        "TARGET_AUTH",
        `Codex-Authentifizierung auf Target ${targetId} ist nicht verfügbar: ${health.auth.message}`,
        targetId,
    );
}

export class RemoteAuthBootstrapper {
    async ensure(target: RemoteAuthTarget, strategy: RemoteAuthStrategy): Promise<TargetHealth> {
        const current = await target.doctor();
        if (current.state === "healthy" && current.auth.state === "authenticated") return current;

        if (strategy.strategy === "existing") return requireHealthy(current, target.id);

        if (strategy.strategy === "sync-file") {
            if (!target.bootstrapAuth) {
                throw new TargetError("TARGET_AUTH", "Remote-Target unterstützt keinen Auth-Bootstrap", target.id);
            }
            const credentials = loadCredentialFile(strategy.source ?? defaultCredentialSource());
            try {
                await target.bootstrapAuth(strategy.codexHome ?? "~/.codex", credentials);
            } finally {
                credentials.fill(0);
            }
        } else {
            if (!target.loginAccessToken) {
                throw new TargetError("TARGET_AUTH", "Remote-Target unterstützt keinen Token-Login", target.id);
            }
            const [command, ...args] = strategy.secretCommand;
            if (!command) throw new TargetError("TARGET_AUTH", "Secret-Command fehlt", target.id);
            const result = await startManagedProcess({
                command,
                args,
                env: buildChildEnvironment(process.env, "ssh"),
                timeoutMs: 30_000,
                killGraceMs: 2_000,
                maxStdoutBytes: MAX_CREDENTIAL_BYTES,
                maxStderrBytes: 16 * 1024,
            }).done;
            if (result.code !== 0 || result.termination !== "normal") {
                throw new TargetError(
                    "TARGET_AUTH",
                    `Secret-Command fehlgeschlagen: ${result.stderr || result.error || result.termination}`,
                    target.id,
                );
            }
            const token = Buffer.from(result.stdout.replace(/[\r\n]+$/, ""));
            if (token.length === 0 || token.length > MAX_CREDENTIAL_BYTES) {
                throw new TargetError("TARGET_AUTH", "Secret-Command lieferte keinen gültigen Token", target.id);
            }
            try {
                await target.loginAccessToken(strategy.codexHome ?? "~/.codex", token);
            } finally {
                token.fill(0);
            }
        }

        return requireHealthy(await target.doctor(), target.id);
    }
}
