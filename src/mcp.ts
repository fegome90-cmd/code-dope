/**
 * MCP adapter: wrap an existing MCP server behind one Code Mode `code` tool,
 * running in Node with QuickJSExecutor + policy + sandbox helpers.
 *
 * Reuses Cloudflare's `codeMcpServer` (@cloudflare/codemode/mcp, MIT), which
 * already handles in-memory upstream connection, tool discovery, TypeScript
 * type generation, MCP result unwrapping and response truncation. This file
 * only supplies what is missing in Node: the executor, the policy and helpers.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import type { Executor } from "@cloudflare/codemode";
import { QuickJSExecutor, type QuickJSExecutorOptions } from "./executor/quickjs-executor.ts";
import { withPolicy, type ToolPolicy } from "./policy.ts";
import { HELPERS_DOC, SANDBOX_HELPERS } from "./helpers.ts";

export const CODE_TOOL_DESCRIPTION = `Execute JavaScript to achieve a goal in one step, calling several tools programmatically.

Available tools (call as \`await codemode.<tool>(args)\`):
{{types}}

Write an async arrow function in plain JavaScript (no TypeScript syntax) and return the final, filtered result.
Tool results do not enter the conversation unless you return them. Calls are policy-checked: unclassified or unapproved write tools fail.
${HELPERS_DOC}

{{example}}`;

export interface CodeModeMcpOptions {
  /** Upstream MCP server whose tools become `codemode.*` methods. */
  upstream: McpServer;
  /** Policy applied to every programmatic tool call. Required: there is no permissive default. */
  policy: ToolPolicy;
  /** Inner executor. Default: new QuickJSExecutor(executorOptions) with helpers preloaded. */
  executor?: Executor;
  executorOptions?: QuickJSExecutorOptions;
  description?: string;
}

export async function createCodeModeMcpServer(o: CodeModeMcpOptions): Promise<McpServer> {
  const inner =
    o.executor ??
    new QuickJSExecutor({ ...o.executorOptions, preludes: [SANDBOX_HELPERS, ...(o.executorOptions?.preludes ?? [])] });
  return codeMcpServer({
    server: o.upstream,
    executor: withPolicy(inner, o.policy),
    description: o.description ?? CODE_TOOL_DESCRIPTION,
  });
}
