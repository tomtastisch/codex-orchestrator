import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifactName = `codex-orchestrator-${pkg.version}.mcpb`;
const artifact = join(root, "release", artifactName);
const archive = readFileSync(artifact);
const expectedChecksum = createHash("sha256").update(archive).digest("hex");
const checksumLine = readFileSync(`${artifact}.sha256`, "utf8");
if (checksumLine !== `${expectedChecksum}  ${artifactName}\n`) {
    throw new Error("MCPB SHA-256 sidecar does not match the release artifact");
}

const entries = unzipSync(archive);
const names = Object.keys(entries).sort();
const allowlist = [
    "LICENSE",
    "manifest.json",
    "server/launcher.mjs",
    "server/server.mjs",
].sort();
for (const name of names) {
    const segments = name.split("/");
    if (
        name.startsWith("/") ||
        name.includes("\\") ||
        name.includes("\0") ||
        /^[A-Za-z]:/.test(name) ||
        segments.includes("..")
    ) {
        throw new Error(`Unsafe MCPB archive entry: ${JSON.stringify(name)}`);
    }
}
if (JSON.stringify(names) !== JSON.stringify(allowlist)) {
    throw new Error(`Unexpected MCPB contents: ${JSON.stringify(names)}`);
}

const embeddedManifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
if (embeddedManifest.version !== pkg.version) {
    throw new Error("Embedded MCPB manifest version does not match package.json");
}
if (/token|api_key|auth\.json/i.test(JSON.stringify(embeddedManifest))) {
    throw new Error("Embedded MCPB manifest must not request or reference credentials");
}

const extraction = mkdtempSync(join(tmpdir(), "codex-orchestrator-mcpb-"));
const project = join(extraction, "project");
const orchHome = join(extraction, "state");
try {
    for (const [name, data] of Object.entries(entries)) {
        const target = resolve(extraction, name);
        const relativeTarget = relative(extraction, target);
        if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
            throw new Error(`MCPB entry escapes extraction directory: ${JSON.stringify(name)}`);
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
    }
    mkdirSync(project);
    for (const args of [
        ["init", "-q"],
        ["config", "user.email", "mcpb-test@example.invalid"],
        ["config", "user.name", "MCPB Test"],
        ["config", "commit.gpgsign", "false"],
        ["commit", "--allow-empty", "-q", "-m", "initial"],
    ]) {
        const git = spawnSync("git", args, { cwd: project, encoding: "utf8", shell: false });
        if (git.status !== 0) throw new Error(`git ${args[0]} failed: ${git.stderr}`);
    }

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(extraction, "server", "launcher.mjs")],
        env: {
            ...process.env,
            ORCH_PROJECT_DIR: project,
            ORCH_HOME: orchHome,
            ORCH_CODEX_BIN: join(root, "tests", "fixtures", "fake-codex.mjs"),
            SKIP_PLUGIN_MARKETPLACE: "true",
        },
        stderr: "pipe",
    });
    const client = new Client(
        { name: "mcpb-verifier", version: "1.0.0" },
        { capabilities: {} },
    );
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        if (tools.tools.length !== 17) {
            throw new Error(`Expected 17 MCP tools, found ${tools.tools.length}`);
        }
        const prompts = await client.listPrompts();
        if (prompts.prompts.length !== 2) {
            throw new Error(`Expected 2 MCP prompts, found ${prompts.prompts.length}`);
        }
        const doctor = await client.callTool({ name: "orchestrator_doctor", arguments: {} });
        const report = JSON.parse(doctor.content[0]?.text ?? "{}");
        if (doctor.isError || report.ok !== true || report.version !== pkg.version) {
            throw new Error(`Extracted MCPB Doctor failed: ${JSON.stringify(report)}`);
        }
    } finally {
        await client.close();
    }
} finally {
    rmSync(extraction, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
    ok: true,
    version: pkg.version,
    checksum: expectedChecksum,
    files: names,
    tools: 17,
    prompts: 2,
    doctor: "healthy",
}, null, 2)}\n`);
