/** Synthetic, deterministic MCP servers used by tests, examples and benchmarks. No network, no real data. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Counters { calls: Record<string, number>; writes: Array<{ tool: string; args: unknown }> }
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const bump = (c: Counters, t: string) => { c.calls[t] = (c.calls[t] ?? 0) + 1; };

export const STATUSES = ["pending", "shipped", "cancelled"] as const;
export const ORDERS = Array.from({ length: 45 }, (_, i) => ({
  id: `o-${i + 1}`,
  customerId: `c-${(i % 9) + 1}`,
  status: STATUSES[i % 3],
  total: ((i * 37) % 500) + 10,
  notes: "x".repeat(200), // bulky field the model usually does not need
}));
export const CUSTOMERS = Array.from({ length: 9 }, (_, i) => ({
  id: `c-${i + 1}`,
  name: `Customer ${i + 1}`,
  tier: i % 3 === 0 ? "gold" : "standard",
  email: `customer${i + 1}@example.test`,
}));

export function ordersServer(counters: Counters = { calls: {}, writes: [] }, opts: { failCustomer?: string } = {}) {
  const s = new McpServer({ name: "orders", version: "1.0.0" });
  s.registerTool("list_orders", {
    description: "List orders, 10 per page. Pass `cursor` from the previous page's `next`.",
    inputSchema: { status: z.enum(STATUSES).optional(), cursor: z.string().optional() },
  }, async ({ status, cursor }) => {
    bump(counters, "list_orders");
    const all = ORDERS.filter((o) => !status || o.status === status);
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + 10);
    const next = start + 10 < all.length ? String(start + 10) : null;
    return json({ items, next });
  });
  s.registerTool("get_customer", {
    description: "Get one customer by id.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    bump(counters, "get_customer");
    if (id === opts.failCustomer) return { content: [{ type: "text" as const, text: `customer ${id} unavailable` }], isError: true };
    const c = CUSTOMERS.find((x) => x.id === id);
    if (!c) return { content: [{ type: "text" as const, text: `not found: ${id}` }], isError: true };
    return json(c);
  });
  s.registerTool("update_order", {
    description: "Update an order's status (side effect).",
    inputSchema: { id: z.string(), status: z.enum(STATUSES) },
  }, async (args) => {
    bump(counters, "update_order");
    counters.writes.push({ tool: "update_order", args });
    return json({ id: args.id, status: args.status, updated: true });
  });
  return { server: s, counters };
}

export const TICKETS = Array.from({ length: 23 }, (_, i) => ({
  ticketId: `t-${i + 1}`,
  priority: ["low", "high", "urgent"][i % 3],
  state: i % 4 === 0 ? "closed" : "open",
  body: "lorem ipsum ".repeat(30),
}));

export function ticketsServer(counters: Counters = { calls: {}, writes: [] }) {
  const s = new McpServer({ name: "tickets", version: "1.0.0" });
  s.registerTool("search_tickets", {
    description: "Search tickets; 5 per page; use `page_token` from `nextPageToken`.",
    inputSchema: { state: z.string().optional(), page_token: z.string().optional() },
  }, async ({ state, page_token }) => {
    bump(counters, "search_tickets");
    const all = TICKETS.filter((t) => !state || t.state === state);
    const start = page_token ? Number(page_token) : 0;
    return json({ results: all.slice(start, start + 5), nextPageToken: start + 5 < all.length ? String(start + 5) : "" });
  });
  s.registerTool("close_ticket", {
    description: "Close a ticket (side effect).",
    inputSchema: { ticketId: z.string() },
  }, async (args) => {
    bump(counters, "close_ticket");
    counters.writes.push({ tool: "close_ticket", args });
    return json({ ...args, state: "closed" });
  });
  return { server: s, counters };
}
