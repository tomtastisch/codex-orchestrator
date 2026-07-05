import { z } from "zod";

const ExistingAuthSchema = z.object({
    strategy: z.literal("existing"),
}).strict();

const SyncFileAuthSchema = z.object({
    strategy: z.literal("sync-file"),
    source: z.string().min(1).optional(),
}).strict();

const AccessTokenAuthSchema = z.object({
    strategy: z.literal("access-token"),
    secretCommand: z.array(z.string().min(1)).min(1),
}).strict();

export const RemoteTargetSchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "id must be a safe target identifier"),
    transport: z.literal("ssh"),
    host: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/, "host must be an SSH alias without options"),
    repository: z.object({
        localRoot: z.string().min(1),
        remoteRoot: z.string().min(1),
    }).strict(),
    codexBin: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("codex"),
    workerRoot: z.string().min(1).default("~/.cache/codex-orchestrator"),
    auth: z.discriminatedUnion("strategy", [ExistingAuthSchema, SyncFileAuthSchema, AccessTokenAuthSchema])
        .default({ strategy: "existing" }),
}).strict();

const LocalExecutionSchema = z.object({
    mode: z.literal("local-only"),
    fallback: z.literal("never").default("never"),
}).strict();

const RemoteOnlyExecutionSchema = z.object({
    mode: z.literal("remote-only"),
    fallback: z.literal("never").default("never"),
    remote: RemoteTargetSchema,
}).strict();

const RemotePreferredExecutionSchema = z.object({
    mode: z.literal("remote-preferred"),
    fallback: z.literal("connectivity-only").default("connectivity-only"),
    remote: RemoteTargetSchema,
}).strict();

export const OrchestratorFileConfigSchema = z.object({
    version: z.literal(1).default(1),
    execution: z.discriminatedUnion("mode", [
        LocalExecutionSchema,
        RemoteOnlyExecutionSchema,
        RemotePreferredExecutionSchema,
    ]).default({ mode: "local-only", fallback: "never" }),
}).strict();

/** @typedef OrchestratorFileConfig */
export type OrchestratorFileConfig = z.infer<typeof OrchestratorFileConfigSchema>;
/** @typedef RemoteTargetConfig */
export type RemoteTargetConfig = z.infer<typeof RemoteTargetSchema>;

export function parseExecutionConfig(input: unknown): OrchestratorFileConfig {
    return OrchestratorFileConfigSchema.parse(input);
}

export function parsePositiveInteger(value: string, variableName: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${variableName} muss eine positive Ganzzahl sein`);
    }
    return parsed;
}
