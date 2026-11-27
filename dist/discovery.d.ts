/**
 * Progressive tool discovery for large catalogs: instead of putting every
 * tool's types in the code tool description, expose
 *   - search_tools({ query, limit }) → matching tools + TypeScript types for them only
 *   - execute({ code })              → run code against the whole (policy-guarded) catalog
 *
 * Pattern from Cloudflare's search/describe/execute and Anthropic's Tool
 * Search; ranking is plain lexical scoring (no embeddings) on purpose.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Executor } from "@cloudflare/codemode";
import type { Isolation } from "./executor/default.ts";
import type { PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";
import { type ToolPolicy } from "./policy.ts";
import { searchTools, typesFor, type ToolEntry } from "./discovery-core.ts";
export { searchTools, typesFor, type ToolEntry };
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
