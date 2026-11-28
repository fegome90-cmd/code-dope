/** Shared upstream calls, response formatting and ownership rules for the MCP adapters. */
import type { Executor } from "@cloudflare/codemode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolEntry } from "./discovery-core.ts";
import { type Isolation } from "./executor/default.ts";
import { type PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";
type Options = {
    upstream: McpServer;
    executor?: Executor;
    isolation?: Isolation;
    executorOptions?: PooledWorkerExecutorOptions;
};
type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type McpResources = Awaited<ReturnType<typeof connectMcpResources>>;
export declare function closeAll(operations: Array<() => Promise<void>>): Promise<void>;
export declare function connectMcpResources(o: Options): Promise<{
    callTool: (params: Parameters<Client["callTool"]>[0], options?: Parameters<Client["callTool"]>[2]) => Promise<{
        [x: string]: unknown;
        content: ({
            type: "text";
            text: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "image";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "audio";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "resource";
            resource: {
                uri: string;
                text: string;
                mimeType?: string | undefined;
                _meta?: Record<string, unknown> | undefined;
            } | {
                uri: string;
                blob: string;
                mimeType?: string | undefined;
                _meta?: Record<string, unknown> | undefined;
            };
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            uri: string;
            name: string;
            type: "resource_link";
            description?: string | undefined;
            mimeType?: string | undefined;
            size?: number | undefined;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
            icons?: {
                src: string;
                mimeType?: string | undefined;
                sizes?: string[] | undefined;
                theme?: "light" | "dark" | undefined;
            }[] | undefined;
            title?: string | undefined;
        })[];
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
        structuredContent?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    } | {
        [x: string]: unknown;
        toolResult: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    }>;
    tools: {
        inputSchema: {
            [x: string]: unknown;
            type: "object";
            properties?: Record<string, object> | undefined;
            required?: string[] | undefined;
        };
        name: string;
        description?: string | undefined;
        outputSchema?: {
            [x: string]: unknown;
            type: "object";
            properties?: Record<string, object> | undefined;
            required?: string[] | undefined;
        } | undefined;
        annotations?: {
            title?: string | undefined;
            readOnlyHint?: boolean | undefined;
            destructiveHint?: boolean | undefined;
            idempotentHint?: boolean | undefined;
            openWorldHint?: boolean | undefined;
        } | undefined;
        execution?: {
            taskSupport?: "optional" | "required" | "forbidden" | undefined;
        } | undefined;
        _meta?: Record<string, unknown> | undefined;
        icons?: {
            src: string;
            mimeType?: string | undefined;
            sizes?: string[] | undefined;
            theme?: "light" | "dark" | undefined;
        }[] | undefined;
        title?: string | undefined;
    }[];
    inner: import("./types.ts").Executor;
    close: () => Promise<void>;
}>;
/** Keeps the Cloudflare compatibility result first, followed by standard MCP representations. */
export declare function unwrapMcpResult(result: CallToolResult): unknown;
export declare function buildUpstreamFns(tools: ToolEntry[], callTool: McpResources["callTool"], signal?: AbortSignal): Record<string, (args: unknown) => Promise<unknown>>;
export declare function formatMcpResponse(text: string, maxChars: number, isError?: boolean): {
    isError?: boolean | undefined;
    content: {
        type: "text";
        text: string;
    }[];
};
/** Explicit close awaits cleanup; transport disconnect also starts it exactly once. */
export declare function bindMcpCleanup(server: McpServer, dispose: () => Promise<void>): McpServer;
export {};
