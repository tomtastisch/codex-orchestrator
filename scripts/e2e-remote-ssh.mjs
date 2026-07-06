#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadCredentialFile, RemoteAuthBootstrapper } from "../dist/auth/bootstrap.js";
import { SshExecutionTarget } from "../dist/execution/ssh/target.js";
import { redactText } from "../dist/redact.js";
import {
    AcceptanceCleanup,
    allocateLoopbackPort,
    findBinary,
    resolveCodexAuthSource,
    retryUntilSuccess,
    runCommand,
} from "./lib/remote-acceptance.mjs";

const realAuth = process.argv.includes("--real-auth");
const root = mkdtempSync(join(tmpdir(), "codex-orchestrator-openssh-"));
const cleanup = new AcceptanceCleanup(root);
const previousHome = process.env.HOME;
const realAuthSource = resolveCodexAuthSource(process.env, homedir());

function requireSuccess(result, label) {
    if (result.code !== 0) {
        throw new Error(`${label} fehlgeschlagen: ${redactText(result.stderr || result.stdout)}`);
    }
    return result;
}

async function runRequired(command, args, label, options = {}) {
    return requireSuccess(await runCommand(command, args, options), label);
}

async function waitForSsh(ssh, configFile, host, environment) {
    let last = "";
    for (let attempt = 0; attempt < 20; attempt++) {
        const result = await runCommand(ssh, ["-F", configFile, "-T", host, "command", "-v", "node"], {
            env: environment,
            timeoutMs: 2_000,
        });
        if (result.code === 0) return;
        last = result.stderr;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Ephemerer SSH-Server wurde nicht bereit: ${redactText(last)}`);
}

try {
    const ssh = findBinary("ssh");
    const scp = findBinary("scp");
    const sshKeygen = findBinary("ssh-keygen");
    const sshKeyscan = findBinary("ssh-keyscan");
    const git = findBinary("git");
    const node = findBinary("node");
    const sshd = existsSync("/usr/sbin/sshd") ? "/usr/sbin/sshd" : findBinary("sshd");
    const codexBin = realAuth
        ? findBinary(process.env.ORCH_CODEX_BIN || "codex")
        : resolve("tests/fixtures/stateful-fake-codex.mjs");
    const workerBundle = resolve("bundle/worker.mjs");
    if (!existsSync(workerBundle)) throw new Error("Worker-Bundle fehlt; zuerst npm run bundle ausführen");

    const sshDirectory = join(root, "ssh");
    const clientHome = join(root, "client-home");
    const clientSsh = join(clientHome, ".ssh");
    const localRoot = join(root, "local-projects");
    const remoteRoot = join(root, "remote-projects");
    const localRepo = join(localRoot, "project");
    const remoteRepo = join(remoteRoot, "project");
    const remoteCodexHome = join(root, "remote-codex-home");
    const workerRoot = join(root, "remote-worker");
    const authSource = join(root, "local-auth.json");
    for (const directory of [sshDirectory, clientSsh, localRoot, remoteRoot]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
    }

    const hostKey = join(sshDirectory, "host-key");
    const userKey = join(sshDirectory, "user-key");
    const authorizedKeys = join(sshDirectory, "authorized_keys");
    await runRequired(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], "Host-Key-Erzeugung");
    await runRequired(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", userKey], "Nutzer-Key-Erzeugung");
    copyFileSync(`${userKey}.pub`, authorizedKeys);
    for (const file of [hostKey, userKey, authorizedKeys]) chmodSync(file, 0o600);

    const port = await allocateLoopbackPort();
    const remotePath = [dirname(node), dirname(codexBin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(":");
    let sshdError = "";
    const daemon = cleanup.track(spawn(sshd, [
        "-D", "-e", "-f", "/dev/null", "-p", String(port), "-h", hostKey,
        "-o", `PidFile=${join(sshDirectory, "sshd.pid")}`,
        "-o", `AuthorizedKeysFile=${authorizedKeys}`,
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "UsePAM=no",
        "-o", "StrictModes=no",
        "-o", "PermitRootLogin=no",
        "-o", "LogLevel=ERROR",
        "-o", "Subsystem=sftp internal-sftp",
        "-o", `SetEnv=PATH=${remotePath}`,
    ], { stdio: ["ignore", "ignore", "pipe"] }));
    daemon.stderr.on("data", (chunk) => { sshdError = `${sshdError}${chunk}`.slice(-64 * 1024); });

    const hostAlias = "codex-orchestrator-loopback";
    const knownHosts = join(clientSsh, "known_hosts");
    const scanned = await retryUntilSuccess(async () => {
        const result = await runCommand(sshKeyscan, ["-p", String(port), "127.0.0.1"], { timeoutMs: 2_000 });
        return requireSuccess(result, "Host-Key-Erfassung");
    });
    writeFileSync(knownHosts, scanned.stdout, { mode: 0o600 });
    const sshConfig = [
        `Host ${hostAlias}`,
        "  HostName 127.0.0.1",
        `  Port ${port}`,
        `  User ${userInfo().username}`,
        `  IdentityFile ${userKey}`,
        `  UserKnownHostsFile ${knownHosts}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        "  IdentitiesOnly yes",
        "",
    ].join("\n");
    const sshConfigFile = join(clientSsh, "config");
    writeFileSync(sshConfigFile, sshConfig, { mode: 0o600 });
    process.env.HOME = clientHome;
    const sshEnvironment = { ...process.env, HOME: clientHome };
    await waitForSsh(ssh, sshConfigFile, hostAlias, sshEnvironment).catch((error) => {
        throw new Error(`${error.message}; sshd=${redactText(sshdError)}`);
    });

    await runRequired(git, ["init", "-q", localRepo], "Lokales Git-Init");
    await runRequired(git, ["-C", localRepo, "config", "user.name", "Remote Acceptance"], "Git-Name");
    await runRequired(git, ["-C", localRepo, "config", "user.email", "acceptance@example.invalid"], "Git-E-Mail");
    await runRequired(git, ["-C", localRepo, "commit", "--allow-empty", "-qm", "initial"], "Initialer Commit");
    await runRequired(git, ["clone", "-q", localRepo, remoteRepo], "Remote-Clone");

    if (realAuth) {
        const credentials = loadCredentialFile(realAuthSource);
        try {
            writeFileSync(authSource, credentials, { mode: 0o600 });
        } finally {
            credentials.fill(0);
        }
    } else {
        writeFileSync(authSource, "synthetic-remote-credential", { mode: 0o600 });
    }
    chmodSync(authSource, 0o600);

    const targetOptions = {
        id: "loopback-remote",
        host: hostAlias,
        localRoot,
        remoteRoot,
        codexBin,
        codexHome: remoteCodexHome,
        workerRoot,
        workerBundlePath: workerBundle,
        sshBin: ssh,
        scpBin: scp,
        configFile: sshConfigFile,
    };
    const firstTarget = new SshExecutionTarget(targetOptions);
    const firstHealth = await new RemoteAuthBootstrapper().ensure(firstTarget, {
        strategy: "sync-file",
        source: authSource,
        codexHome: remoteCodexHome,
    });
    if (firstHealth.state !== "healthy") throw new Error(`Erster Remote-Doctor ist ${firstHealth.state}`);
    const remoteAuth = join(remoteCodexHome, "auth.json");
    if (!existsSync(remoteAuth)) throw new Error("Remote auth.json wurde nicht angelegt");
    if (process.platform !== "win32" && (statSync(remoteAuth).mode & 0o777) !== 0o600) {
        throw new Error("Remote auth.json besitzt nicht Modus 0600");
    }

    if (!realAuth) {
        const outcome = await firstTarget.startCodex({
            repoPath: localRepo,
            prompt: "verify remote authentication",
            sandbox: "read-only",
            model: "gpt-5.5",
            effort: "low",
            network: false,
            timeoutMs: 5_000,
        }).done;
        if (outcome.status !== "normal" || outcome.threadId !== "stateful-thread") {
            throw new Error(`Remote-Slice fehlgeschlagen: ${outcome.errorMessage || outcome.status}`);
        }
    }

    unlinkSync(authSource);
    const restartedTarget = new SshExecutionTarget(targetOptions);
    const restartedHealth = await new RemoteAuthBootstrapper().ensure(restartedTarget, { strategy: "existing" });
    if (restartedHealth.state !== "healthy") throw new Error(`Doctor nach Neustart ist ${restartedHealth.state}`);

    process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: realAuth ? "real-auth" : "synthetic",
        sshTransport: "openssh-loopback",
        workerDeployed: true,
        authMode: firstHealth.auth.method,
        authPersistedAfterRestart: true,
        remoteAuthMode: (statSync(remoteAuth).mode & 0o777).toString(8).padStart(4, "0"),
        modelTurnExecuted: !realAuth,
    }, null, 2)}\n`);
} catch (error) {
    process.stderr.write(`${redactText(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    process.exitCode = 1;
} finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await cleanup.run();
}
