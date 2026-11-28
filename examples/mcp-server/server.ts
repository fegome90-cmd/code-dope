/**
 * Example: a Node MCP server (stdio) that exposes a synthetic upstream MCP
 * server through a single Code Mode `code` tool.
 *
 *   node examples/mcp-server/server.ts orders|tickets
 *
 * Writes are denied unless CODE_DOPE_APPROVE_WRITES=1 (stand-in for a real
 * human approval flow). Audit records go to stderr as JSON lines.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodeModeMcpServer } from "../../src/mcp.ts";
import { ordersServer, ticketsServer } from "../../tests/fixtures/servers.ts";

const which = process.argv[2] ?? "orders";
const upstream = which === "tickets" ? ticketsServer().server : ordersServer().server;
const policy = which === "tickets"
  ? { read: ["search_tickets"], write: ["close_ticket"] }
  : { read: ["list_orders", "get_customer"], write: ["update_order"] };

const server = await createCodeModeMcpServer({
  upstream,
  policy: {
    ...policy,
    approve: () => process.env.CODE_DOPE_APPROVE_WRITES === "1",
    maxCalls: 100,
    audit: (r) => process.stderr.write(JSON.stringify({ audit: r }) + "\n"),
  },
  executorOptions: { timeoutMs: 20_000 },
});
await server.connect(new StdioServerTransport());
