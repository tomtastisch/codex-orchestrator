import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = join(root, "packaging", "mcpb");
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
    throw new Error(`MCPB manifest version ${manifest.version} does not match package version ${pkg.version}`);
}

const release = join(root, "release");
const staging = join(release, "mcpb", "staging");
const stagingServer = join(staging, "server");
const artifact = join(release, `codex-orchestrator-${pkg.version}.mcpb`);
const checksumFile = `${artifact}.sha256`;
rmSync(join(release, "mcpb"), { recursive: true, force: true });
rmSync(artifact, { force: true });
rmSync(checksumFile, { force: true });
mkdirSync(stagingServer, { recursive: true });

for (const [from, to] of [
    [join(source, "manifest.json"), join(staging, "manifest.json")],
    [join(source, ".mcpbignore"), join(staging, ".mcpbignore")],
    [join(source, "server", "launcher.mjs"), join(stagingServer, "launcher.mjs")],
    [join(root, "bundle", "server.mjs"), join(stagingServer, "server.mjs")],
    [join(root, "LICENSE"), join(staging, "LICENSE")],
]) {
    copyFileSync(from, to);
}

const cli = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
const frozenTime = resolve(root, "scripts", "freeze-mcpb-time.mjs");

function runMcpb(args, options = {}) {
    const result = spawnSync(process.execPath, ["--import", frozenTime, cli, ...args], {
        cwd: root,
        encoding: "utf8",
        shell: false,
        ...options,
    });
    if (result.status !== 0) {
        throw new Error([
            `mcpb ${args[0]} failed with status ${result.status}`,
            result.stdout,
            result.stderr,
        ].filter(Boolean).join("\n"));
    }
    return result;
}

runMcpb(["validate", join(staging, "manifest.json")]);
runMcpb(["pack", staging, artifact]);

const bytes = readFileSync(artifact);
const checksum = createHash("sha256").update(bytes).digest("hex");
writeFileSync(checksumFile, `${checksum}  ${basename(artifact)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
    version: pkg.version,
    artifact,
    bytes: statSync(artifact).size,
    checksum,
}, null, 2)}\n`);
