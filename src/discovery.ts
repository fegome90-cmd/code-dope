/**
 * Progressive tool discovery for large catalogs: instead of putting every
 * tool's types in the tool description (what codeMcpServer does), expose
 *   - search_tools({ query, limit }) → matching tools + TypeScript types for them only
 *   - execute({ code })              → run code against the whole (policy-guarded) catalog
 *
 * Pattern from Cloudflare's search/describe/execute and Anthropic's Tool
 * Search; ranking is plain lexical scoring (no embeddings) on purpose.
 */
import type { JSONSchema7 } from "json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { Executor } from "@cloudflare/codemode";
import { generateTypesFromJsonSchema } from "./vendor/cf-json-schema-types.ts";
import { sanitizeToolName } from "./vendor/cf-utils.ts";
import { QuickJSExecutor, type QuickJSExecutorOptions } from "./executor/quickjs-executor.ts";
import { withPolicy, type ToolPolicy } from "./policy.ts";
import { HELPERS_DOC, SANDBOX_HELPERS } from "./helpers.ts";

export interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const tokens = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

/** Rank tools by token overlap with the query (name weighted 3x description). */
export function searchTools(catalog: ToolEntry[], query: string, limit = 5): ToolEntry[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return catalog.slice(0, limit);
  return catalog
    .map((t) => {
      const name = new Set(tokens(t.name));
      const desc = new Set(tokens(t.description ?? ""));
      const score = q.reduce((s, w) => s + (name.has(w) ? 3 : 0) + (desc.has(w) ? 1 : 0), 0);
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}

/** TypeScript declarations for a subset of tools (Cloudflare generator, vendored). */
export function typesFor(tools: ToolEntry[]): string {
  return generateTypesFromJsonSchema(
    Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: (t.inputSchema ?? { type: "object" }) as JSONSchema7 }])),
  );
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** Same priority order as Cloudflare's unwrapMcpResult (mcp.ts): isError → throw, structuredContent, text→JSON. */
function unwrap(result: CallToolResult): unknown {
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

export interface SearchExecuteOptions {
  upstream: McpServer;
  policy: ToolPolicy;
  executor?: Executor;
  executorOptions?: QuickJSExecutorOptions;
  /** Max characters returned to the model from `execute`. Default 24_000 (~6k tokens), like Cloudflare. */
  maxResponseChars?: number;
}

export async function createSearchExecuteMcpServer(o: SearchExecuteOptions): Promise<McpServer> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await o.upstream.connect(st);
  const client = new Client({ name: "code-dope-discovery", version: "0.1.0" });
  await client.connect(ct);
  const { tools } = await client.listTools();
  const catalog: ToolEntry[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const t of tools) {
    fns[sanitizeToolName(t.name)] = async (args) =>
      unwrap(await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> }));
  }
  const inner = o.executor ?? new QuickJSExecutor({ ...o.executorOptions, preludes: [SANDBOX_HELPERS, ...(o.executorOptions?.preludes ?? [])] });
  const executor = withPolicy(inner, o.policy);
  const max = o.maxResponseChars ?? 24_000;

  const server = new McpServer({ name: "code-dope-search-execute", version: "0.1.0" });
  server.registerTool(
    "search_tools",
    {
      description: `Find tools for a task among ${catalog.length} available. Returns names, descriptions and TypeScript types for the matches only. Search before writing code; never guess tool names.`,
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const hits = searchTools(catalog, query, limit ?? 5);
      const body = hits.length
        ? `${hits.map((h) => `- ${sanitizeToolName(h.name)}: ${h.description ?? ""}`).join("\n")}\n\n${typesFor(hits)}`
        : "No matching tools. Try other words.";
      return { content: [{ type: "text", text: body }] };
    },
  );
  server.registerTool(
    "execute",
    {
      description: `Run an async arrow function (plain JavaScript) that calls tools as \`await codemode.<tool>(args)\`. Return only the final, filtered result.\n${HELPERS_DOC}`,
      inputSchema: { code: z.string() },
    },
    async ({ code }) => {
      const r = await executor.execute(code, [{ name: "codemode", fns }]);
      if (r.error) return { content: [{ type: "text", text: `Error: ${r.error}` }], isError: true };
      let text = r.result === undefined ? "undefined" : JSON.stringify(r.result, null, 2);
      if (text.length > max) text = text.slice(0, max) + `\n…[truncated ${text.length - max} chars; filter or summarize in code]`;
      return { content: [{ type: "text", text }] };
    },
  );
  return server;
}
