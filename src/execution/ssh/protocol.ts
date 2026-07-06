import { resolve, sep } from "node:path";
import { z } from "zod";

export const WORKER_PROTOCOL_VERSION = 1 as const;

const RequestBase = {
    requestId: z.string().uuid(),
    protocol: z.literal(WORKER_PROTOCOL_VERSION),
};

const RepositoryScope = z.object({
    allowedRoot: z.string().min(1),
    cwd: z.string().min(1),
}).strict().superRefine(({ allowedRoot, cwd }, context) => {
    const root = resolve(allowedRoot);
    const candidate = resolve(cwd);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cwd"],
            message: "cwd must resolve within allowedRoot",
        });
    }
});

const ScopedShape = {
    allowedRoot: z.string().min(1),
    cwd: z.string().min(1),
};

const safeScope = <T extends z.ZodRawShape>(shape: T) => z.object({
    ...RequestBase,
    ...ScopedShape,
    ...shape,
}).strict().superRefine((value, context) => {
    const result = RepositoryScope.safeParse({ allowedRoot: value.allowedRoot, cwd: value.cwd });
    if (!result.success) {
        for (const issue of result.error.issues) context.addIssue(issue);
    }
});

const GitArgumentsSchema = z.array(z.string().min(1).max(4_096)).min(1).max(32).superRefine((args, context) => {
    const allowed = new Set(["rev-parse", "status", "diff", "ls-files", "worktree", "merge", "branch"]);
    if (!allowed.has(args[0])) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Git subcommand is not allowed" });
    }
    if (args.some((argument) => argument.includes("\0") || argument.includes("\n") || argument.includes("\r"))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Git args contain invalid control characters" });
    }
});

const CheckNameSchema = z.enum([
    "git_diff_summary",
    "git_status",
    "mvn_test",
    "npm_test",
    "npm_build",
    "lint",
    "typecheck",
]);

const CodexHomeSchema = z.string().regex(
    /^(?:~\/|\/)[A-Za-z0-9._/-]+$/,
    "codexHome must be absolute or start with ~/ and contain no shell characters",
).refine((value) => !value.split("/").includes(".."), "codexHome must not contain traversal");

const WorkerRequestSchema = z.union([
    z.object({ ...RequestBase, operation: z.literal("handshake") }).strict(),
    z.object({
        ...RequestBase,
        operation: z.literal("doctor"),
        codexBin: z.string().min(1).optional(),
        codexHome: CodexHomeSchema,
    }).strict(),
    safeScope({ operation: z.literal("repository.identity") }),
    safeScope({ operation: z.literal("check.run"), checkName: CheckNameSchema }),
    safeScope({ operation: z.literal("git.run"), args: GitArgumentsSchema }),
    safeScope({
        operation: z.literal("codex.run"),
        codexBin: z.string().min(1),
        codexHome: CodexHomeSchema,
        options: z.object({
            threadId: z.string().nullable().optional(),
            prompt: z.string().max(2_000_000),
            sandbox: z.enum(["read-only", "workspace-write"]),
            model: z.string().min(1),
            effort: z.enum(["low", "medium", "high", "xhigh"]),
            network: z.boolean(),
            timeoutMs: z.number().int().positive().max(4 * 60 * 60_000),
            extraConfig: z.record(z.string()).optional(),
        }).strict(),
    }),
    z.object({
        ...RequestBase,
        operation: z.literal("auth.status"),
        codexBin: z.string().min(1),
        codexHome: CodexHomeSchema,
    }).strict(),
    z.object({
        ...RequestBase,
        operation: z.literal("auth.bootstrap"),
        codexHome: CodexHomeSchema,
        credentialBase64: z.string().max(128 * 1024),
    }).strict(),
    z.object({
        ...RequestBase,
        operation: z.literal("auth.login-token"),
        codexBin: z.string().min(1),
        codexHome: CodexHomeSchema,
        tokenBase64: z.string().max(128 * 1024),
    }).strict(),
]);

/** @typedef WorkerRequest */
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export function parseWorkerRequest(input: unknown): WorkerRequest {
    return WorkerRequestSchema.parse(input);
}

/** @typedef WorkerFrame */
export type WorkerFrame =
    | { frame: "event"; requestId: string; line: string }
    | { frame: "result"; requestId: string; ok: true; data: unknown }
    | { frame: "result"; requestId: string; ok: false; error: { code: string; message: string } };
