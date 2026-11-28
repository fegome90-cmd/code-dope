/**
 * Parent-side half of the worker tool bridge, shared by WorkerExecutor and
 * PooledWorkerExecutor. The worker sends {provider, tool, args}; the parent runs
 * the real tool function (credentials stay here) and replies with JSON data only.
 */
import type { ResolvedProvider } from "../types.ts";
export type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;
export interface CallMsg {
    type: "call";
    job?: number;
    id: number;
    provider: string;
    tool: string;
    args: unknown;
}
export interface ReplyMsg {
    type: "reply";
    job?: number;
    id: number;
    ok: boolean;
    value?: unknown;
    error?: string;
}
export interface ProviderSpec {
    name: string;
    tools: string[];
    prelude?: string;
}
export declare function toProviders(p: ResolvedProvider[] | Fns): ResolvedProvider[];
/** What the worker needs to rebuild provider proxies: names only, never functions. */
export declare function providerSpecs(providers: ResolvedProvider[]): ProviderSpec[];
/** Runs one forwarded tool call in the parent and builds the reply message. Never throws. */
export declare function runCall(byName: Map<string, Fns>, m: CallMsg): Promise<ReplyMsg>;
