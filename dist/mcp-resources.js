import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createDefaultExecutor } from "./executor/default.js";
import { PooledWorkerExecutor } from "./executor/pool-executor.js";
export async function closeAll(operations) {
    const results = await Promise.allSettled(operations.map((close) => Promise.resolve().then(close)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
        throw failed.reason;
}
export async function connectMcpResources(o) {
    if (o.upstream.server.transport)
        throw new Error("Upstream MCP server is already connected; its connection is caller-owned");
    const inner = o.executor ?? createDefaultExecutor(o.isolation, o.executorOptions);
    const ownedPool = o.executor === undefined && inner instanceof PooledWorkerExecutor ? inner : undefined;
    const client = new Client({ name: "code-dope-upstream", version: "0.1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    let closed;
    const close = () => closed ??= closeAll([() => client.transport ? client.close() : ct.close(), ...(ownedPool ? [() => ownedPool.close()] : [])]);
    try {
        await o.upstream.connect(st);
        await client.connect(ct);
        const tools = [];
        const seen = new Set();
        let cursor;
        do {
            const page = await client.listTools(cursor === undefined ? undefined : { cursor });
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor !== undefined) {
                if (seen.has(cursor))
                    throw new Error("Upstream tools/list repeated a cursor; refusing an incomplete catalog");
                seen.add(cursor);
            }
        } while (cursor !== undefined);
        // Client.listTools replaces its metadata cache on each page. Preserve the
        // full catalog's validation and task requirements through public SDK APIs.
        const schemaValidator = new AjvJsonSchemaValidator();
        const validators = new Map(tools.filter((tool) => tool.outputSchema).map((tool) => [tool.name, schemaValidator.getValidator(tool.outputSchema)]));
        const requiredTasks = new Set(tools.filter((tool) => tool.execution?.taskSupport === "required").map((tool) => tool.name));
        const callTool = async (params, options) => {
            if (requiredTasks.has(params.name))
                throw new McpError(ErrorCode.InvalidRequest, `Tool "${params.name}" requires task-based execution`);
            const result = await client.callTool(params, undefined, options);
            const validate = validators.get(params.name);
            if (validate) {
                if (!result.structuredContent && !result.isError)
                    throw new McpError(ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
                if (result.structuredContent) {
                    try {
                        const validation = validate(result.structuredContent);
                        if (!validation.valid)
                            throw new McpError(ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validation.errorMessage}`);
                    }
                    catch (error) {
                        if (error instanceof McpError)
                            throw error;
                        throw new McpError(ErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            return result;
        };
        return { callTool, tools, inner, close };
    }
    catch (error) {
        await close().catch(() => { });
        throw error;
    }
}
/** Explicit close awaits cleanup; transport disconnect also starts it exactly once. */
export function bindMcpCleanup(server, dispose) {
    let pending;
    const cleanup = () => pending ??= Promise.resolve().then(dispose);
    const close = server.close.bind(server);
    const onclose = server.server.onclose;
    server.server.onclose = () => {
        try {
            onclose?.call(server.server);
        }
        finally {
            void cleanup().catch(() => { });
        }
    };
    server.close = async () => {
        try {
            await close();
        }
        finally {
            await cleanup();
        }
    };
    return server;
}
