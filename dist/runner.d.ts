/**
 * createCodeRunner: the one-call entry point for plugins and other in-process
 * consumers that already have tool functions (no MCP needed).
 */
import type { ExecuteResult } from "@cloudflare/codemode";
import { type Isolation } from "./executor/default.ts";
import type { PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";
import { type AuditRecord, type ToolPolicy } from "./policy.ts";
type Fn = (args: unknown) => Promise<unknown> | unknown;
export interface CodeRunnerOptions {
    /** Tool functions by namespace, e.g. { crm: { getCustomer }, mail: { send } }. */
    tools: Record<string, Record<string, Fn>>;
    policy: ToolPolicy;
    executor?: PooledWorkerExecutorOptions;
    /** Default "worker". */
    isolation?: Isolation;
}
export interface CodeRunResult extends ExecuteResult {
    audit: AuditRecord[];
    durationMs: number;
}
export interface CodeRunner {
    run(code: string): Promise<CodeRunResult>;
}
export declare function createCodeRunner(o: CodeRunnerOptions): CodeRunner;
export {};
