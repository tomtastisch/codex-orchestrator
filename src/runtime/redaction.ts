const REDACTED = "[REDACTED]";

const SECRET_ASSIGNMENT = new RegExp(
    String.raw`\b(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\s*([:=])\s*([^\s]+)`,
    "gi",
);

/** Redacts credential-shaped data before it reaches logs, SQLite or MCP output. */
export function redact(value: string): string {
    return value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
        .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
        .replace(/([?&](?:access_token|api_key|token)=)[^&\s]+/gi, `$1${REDACTED}`)
        .replace(/-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g, REDACTED);
}
