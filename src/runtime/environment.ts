/** @typedef ChildProcessPurpose */
export type ChildProcessPurpose = "codex" | "repository-check" | "ssh";

const COMMON_ENVIRONMENT = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
] as const;

const CODEX_ENVIRONMENT = ["CODEX_HOME", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"] as const;
const SSH_ENVIRONMENT = ["SSH_AUTH_SOCK"] as const;

/**
 * Builds the minimum environment required by a child process. Repository code
 * never inherits credentials from the MCP server process.
 */
export function buildChildEnvironment(
    source: NodeJS.ProcessEnv,
    purpose: ChildProcessPurpose,
): NodeJS.ProcessEnv {
    const allowed = purpose === "codex"
        ? [...COMMON_ENVIRONMENT, ...CODEX_ENVIRONMENT]
        : purpose === "ssh"
            ? [...COMMON_ENVIRONMENT, ...SSH_ENVIRONMENT]
            : COMMON_ENVIRONMENT;

    const result: NodeJS.ProcessEnv = {};
    for (const key of allowed) {
        const value = source[key];
        if (value !== undefined) result[key] = value;
    }
    return result;
}
