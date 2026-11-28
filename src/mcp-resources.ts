/** Shared upstream calls, response formatting and ownership rules for the MCP adapters. */
import type { Executor } from "@cloudflare/codemode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ToolEntry } from "./discovery-core.ts";
import { createDefaultExecutor, type Isolation } from "./executor/default.ts";
import { PooledWorkerExecutor, type PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";

type Options = { upstream: McpServer; executor?: Executor; isolation?: Isolation; executorOptions?: PooledWorkerExecutorOptions };
type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type McpResources = Awaited<ReturnType<typeof connectMcpResources>>;

export async function closeAll(operations: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(operations.map((close) => Promise.resolve().then(close)));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function connectMcpResources(o: Options) {
  if (o.upstream.server.transport) throw new Error("Upstream MCP server is already connected; its connection is caller-owned");
  const inner = o.executor ?? createDefaultExecutor(o.isolation, o.executorOptions);
  const ownedPool = o.executor === undefined && inner instanceof PooledWorkerExecutor ? inner : undefined;
  const client = new Client({ name: "code-dope-upstream", version: "0.1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  let closed: Promise<void> | undefined;
  const close = () => closed ??= closeAll([() => client.transport ? client.close() : ct.close(), ...(ownedPool ? [() => ownedPool.close()] : [])]);
  try {
    await o.upstream.connect(st);
    await client.connect(ct);
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("Upstream tools/list repeated a cursor; refusing an incomplete catalog");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    // Client.listTools replaces its metadata cache on each page. Preserve the
    // full catalog's validation and task requirements through public SDK APIs.
    const schemaValidator = new AjvJsonSchemaValidator();
    const validators = new Map(tools.filter((tool) => tool.outputSchema).map((tool) => [tool.name, schemaValidator.getValidator(tool.outputSchema!)]));
    const requiredTasks = new Set(tools.filter((tool) => tool.execution?.taskSupport === "required").map((tool) => tool.name));
    const callTool = async (params: Parameters<Client["callTool"]>[0], options?: Parameters<Client["callTool"]>[2]) => {
      if (requiredTasks.has(params.name)) throw new McpError(ErrorCode.InvalidRequest, `Tool "${params.name}" requires task-based execution`);
      const result = await client.callTool(params, undefined, options);
      const validate = validators.get(params.name);
      if (validate) {
        if (!result.structuredContent && !result.isError) throw new McpError(ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
        if (result.structuredContent) {
          try {
            const validation = validate(result.structuredContent);
            if (!validation.valid) throw new McpError(ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validation.errorMessage}`);
          } catch (error) {
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return result;
    };
    return { callTool, tools, inner, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** Keeps the Cloudflare compatibility result first, followed by standard MCP representations. */
export function unwrapMcpResult(result: CallToolResult): unknown {
  if ("toolResult" in result) return result.toolResult;
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = () => content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (result.isError) throw new Error(text() || "Tool call failed");
  if (result.structuredContent != null) return result.structuredContent;
  if (content.length > 0 && content.every((c) => c.type === "text")) {
    try {
      return JSON.parse(text());
    } catch {
      return text();
    }
  }
  return result;
}

export function buildUpstreamFns(
  tools: ToolEntry[],
  callTool: McpResources["callTool"],
  signal?: AbortSignal,
): Record<string, (args: unknown) => Promise<unknown>> {
  // Keep original names for policy matching; the executor resolves aliases.
  return Object.fromEntries(tools.map(({ name }) => [
    name,
    async (args: unknown) => unwrapMcpResult(await callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, signal ? { signal } : undefined)),
  ]));
}

export function formatMcpResponse(text: string, maxChars: number, isError = false) {
  const marker = "…[truncated]";
  if (text.length > maxChars) text = maxChars < marker.length ? marker.slice(0, maxChars) : text.slice(0, maxChars - marker.length) + marker;
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Explicit close awaits cleanup; transport disconnect also starts it exactly once. */
export function bindMcpCleanup(server: McpServer, dispose: () => Promise<void>): McpServer {
  let pending: Promise<void> | undefined;
  const cleanup = () => pending ??= Promise.resolve().then(dispose);
  const close = server.close.bind(server);
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    try { onclose?.call(server.server); }
    finally { void cleanup().catch(() => {}); }
  };
  server.close = async () => {
    try { await close(); }
    finally { await cleanup(); }
  };
  return server;
}
