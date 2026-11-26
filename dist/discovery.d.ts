import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Executor } from "@cloudflare/codemode";
import type { Isolation } from "./executor/default.ts";
import type { PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";
import { type ToolPolicy } from "./policy.ts";
export interface ToolEntry {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
/** Rank tools by word overlap with the query (name weighted 3x description). Empty query → no results. */
export declare function searchTools(catalog: ToolEntry[], query: string, limit?: number): ToolEntry[];
/** TypeScript declarations for a subset of tools (Cloudflare generator, vendored). */
export declare function typesFor(tools: ToolEntry[], ambiguous?: Set<string>): string;
export interface SearchExecuteOptions {
    upstream: McpServer;
    policy: ToolPolicy;
    executor?: Executor;
    executorOptions?: PooledWorkerExecutorOptions;
    /** Default "worker". */
    isolation?: Isolation;
    /** Max characters returned from `execute`, including errors and the truncation marker. Default 24_000. */
    maxResponseChars?: number;
}
export declare function createSearchExecuteMcpServer(o: SearchExecuteOptions): Promise<McpServer>;
