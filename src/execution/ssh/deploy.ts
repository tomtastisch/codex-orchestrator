import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildChildEnvironment } from "../../runtime/environment.js";
import { startManagedProcess } from "../../runtime/process.js";
import { ORCHESTRATOR_VERSION } from "../../version.js";
import { TargetError } from "../errors.js";
import { scpOptions, sshOptions, type SshClientOptions } from "./client.js";

/** @typedef WorkerDeploymentOptions */
export interface WorkerDeploymentOptions extends SshClientOptions {
    workerBundlePath: string;
    workerRoot: string;
    scpBin?: string;
}

function safeRemotePath(path: string): void {
    if (!/^(?:~\/|\/)[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) {
        throw new TargetError("TARGET_POLICY", "Unsicherer Remote-Worker-Pfad", "remote");
    }
}

async function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
    const processResult = await startManagedProcess({
        command,
        args,
        env: buildChildEnvironment(process.env, "ssh"),
        timeoutMs,
        killGraceMs: 2_000,
        maxStdoutBytes: 64_000,
        maxStderrBytes: 64_000,
    }).done;
    return { code: processResult.code, output: `${processResult.stdout}${processResult.stderr}` };
}

export class WorkerDeployer {
    constructor(private readonly options: WorkerDeploymentOptions) {}

    async ensure(): Promise<string> {
        if (!existsSync(this.options.workerBundlePath)) {
            throw new TargetError("TARGET_VERSION", "Remote-Worker-Bundle fehlt", this.options.host);
        }
        safeRemotePath(this.options.workerRoot);
        const bytes = readFileSync(this.options.workerBundlePath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const directory = `${this.options.workerRoot}/${ORCHESTRATOR_VERSION}/${hash}`;
        const destination = `${directory}/worker.mjs`;
        const temporary = `${destination}.tmp`;
        const common = sshOptions(this.options);

        const present = await run(this.options.sshBin ?? "ssh", [
            ...common, this.options.host, "test", "-f", destination,
        ], 15_000);
        if (present.code === 0) return destination;

        const created = await run(this.options.sshBin ?? "ssh", [
            ...common, this.options.host, "mkdir", "-p", directory,
        ], 15_000);
        if (created.code !== 0) {
            throw new TargetError("TARGET_CONNECTIVITY", `Worker-Verzeichnis nicht erstellbar: ${created.output}`, this.options.host, true);
        }

        const copied = await run(this.options.scpBin ?? "scp", [
            ...scpOptions(this.options),
            this.options.workerBundlePath, `${this.options.host}:${temporary}`,
        ], 60_000);
        if (copied.code !== 0) {
            throw new TargetError("TARGET_CONNECTIVITY", `Worker-Upload fehlgeschlagen: ${copied.output}`, this.options.host, true);
        }

        const activated = await run(this.options.sshBin ?? "ssh", [
            ...common, this.options.host, "chmod", "700", temporary, "&&", "mv", temporary, destination,
        ], 15_000);
        if (activated.code !== 0) {
            throw new TargetError("TARGET_CONNECTIVITY", `Worker-Aktivierung fehlgeschlagen: ${activated.output}`, this.options.host, true);
        }
        return destination;
    }
}
