/**
 * Policy layer: an Executor decorator that wraps every host tool function
 * BEFORE the sandbox can reach it. Because the guest can only call what the
 * executor exposes, programmatic calls are subject to exactly the same rules
 * as individual calls — they cannot bypass allowlists or approvals.
 *
 * Fail-closed defaults:
 *  - A tool must be classified as `read` or `write`; unclassified tools are denied.
 *  - `write` tools require `approve()` to return true; without it they are denied.
 *  - Call budget, per-call timeout and argument validation apply to every call.
 *
 * Works with any `Executor` (QuickJSExecutor, Cloudflare's DynamicWorkerExecutor, …).
 */
import type { Executor } from "@cloudflare/codemode";
export type ToolKind = "read" | "write";
type Fn = (...args: unknown[]) => Promise<unknown>;
type Fns = Record<string, Fn>;
/** A validator returns true/undefined when valid, or an error message. zod-like `safeParse` objects also work. */
export type ArgValidator = ((args: unknown) => true | undefined | string) | {
    safeParse(args: unknown): {
        success: boolean;
        error?: {
            message: string;
        };
    };
};
export interface ApprovalRequest {
    provider: string;
    tool: string;
    args: unknown;
    /** Aborted when the enclosing execution ends; always supplied by withPolicy. */
    signal?: AbortSignal;
}
export interface AuditRecord {
    seq: number;
    provider: string;
    tool: string;
    kind: ToolKind | "unclassified";
    decision: "allowed" | "denied";
    reason?: string;
    ok?: boolean;
    error?: string;
    /** "unknown" when the call timed out: the tool may still have completed its side effect. */
    outcome?: "done" | "failed" | "unknown";
    /** The call was already in flight and settled after its execution ended. */
    afterExecutionEnd?: boolean;
    durationMs: number;
    argsChars: number;
    resultChars?: number;
}
export interface ToolPolicy {
    /** Tools without side effects. Names match `tool` or `provider.tool`; collisions require exact names, even with `"*"`. */
    read?: string[];
    /** Tools with side effects. Each call needs `approve()` → true. */
    write?: string[];
    /** Always denied, evaluated first. Names are sanitized even when tools collide. */
    deny?: string[];
    /** Approval hook for write tools. Missing hook ⇒ writes denied. */
    approve?: (req: ApprovalRequest) => boolean | Promise<boolean>;
    /** Per-tool argument validators; colliding tool names match exactly. */
    validate?: Record<string, ArgValidator>;
    /** Max host tool calls per execution. Default 50. */
    maxCalls?: number;
    /** Per-call timeout in ms. Default 15_000. */
    callTimeoutMs?: number;
    /** Max characters of a single tool result passed back to the guest. Default 1_000_000. */
    maxResultChars?: number;
    /** Receives one record per attempted call (allowed or denied). */
    audit?: (record: AuditRecord) => void;
}
export declare class PolicyError extends Error {
    name: string;
}
/** Real names that share a sanitized alias with a different tool in one provider. */
export declare function collisions(names: string[]): Set<string>;
/** Exact allowlist matching for ambiguous names; deny lists always use sanitization. */
export declare function matches(list: string[] | undefined, provider: string, tool: string, { exact }?: {
    exact?: boolean | undefined;
}): boolean;
/** Whether a tool can be advertised; approval and validation still apply at invocation. */
export declare function policyAllows(p: ToolPolicy, provider: string, tool: string, ambiguous: Set<string>): boolean;
type ExecutionState = {
    calls: number;
    seq: number;
    closed?: boolean;
    abort?: AbortController;
};
/** Wrap one provider's fns. Without a shared execution state, the guards never close. */
export declare function guardFns(provider: string, fns: Fns, policy: ToolPolicy, state?: ExecutionState): Fns;
/** Decorate any Executor so every tool function it receives is policy-guarded. */
export declare function withPolicy(inner: Executor, policy: ToolPolicy): Executor;
/** In-memory audit sink. Keeps the first `maxRecords` records and counts the rest. */
export declare function createAuditLog(maxRecords?: number): {
    records: AuditRecord[];
    readonly dropped: number;
    sink: (r: AuditRecord) => void;
    summary(): {
        dropped: number;
        calls: number;
        denied: number;
        errors: number;
        resultChars: number;
    };
};
export {};
