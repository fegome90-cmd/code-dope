import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCodeModeMcpServer, createSearchExecuteMcpServer, CODE_TOOL_DESCRIPTION } from "../src/mcp.ts";
import { paginatedFilter } from "../src/recipes.ts";
import { ordersServer, ticketsServer, ORDERS, TICKETS, type Counters } from "./fixtures/servers.ts";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connect(server: Awaited<ReturnType<typeof createCodeModeMcpServer>>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(a);
  return client;
}
async function code(client: Client, src: string) {
  const r = (await client.callTool({ name: "code", arguments: { code: src } })) as TextResult;
  return { isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
}

test("code tool is the only exposed tool and carries generated types + helpers doc", async (t) => {
  const client = await connect(await createCodeModeMcpServer({
    upstream: ordersServer().server,
    policy: { read: ["list_orders", "get_customer"], write: ["update_order"] },
  }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["code"]);
  const d = tools[0].description ?? "";
  for (const s of ["list_orders", "get_customer", "update_order", "helpers.paginate", "cursor"]) assert.ok(d.includes(s), `missing ${s}`);
  assert.ok(CODE_TOOL_DESCRIPTION.includes("{{types}}"));
});

for (const createServer of [createCodeModeMcpServer, createSearchExecuteMcpServer]) {
  test(`${createServer.name} rejects a misqualified dotted rule and releases its upstream`, async () => {
    const upstream = new McpServer({ name: "fixture", version: "1" });
    let calls = 0;
    upstream.registerTool("catalog.lookup", {}, async () => {
      calls++;
      return { content: [{ type: "text", text: "fixture" }] };
    });
    try {
      await assert.rejects(async () => {
        const server = await createServer({ upstream, policy: { deny: ["catalog.lookup"] } });
        await server.close();
      }, { name: "PolicyError", message: /unknown provider prefix "catalog".*"codemode\.catalog\.lookup"$/ });
      assert.equal(upstream.server.transport, undefined);
      assert.equal(calls, 0);
    } finally {
      await upstream.close();
    }
  });
}

test("code description and example include only policy-classified, non-denied tools", async (t) => {
  const client = await connect(await createCodeModeMcpServer({
    upstream: ordersServer().server,
    policy: { read: ["list_orders", "get_customer"], deny: ["list_orders"] },
  }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const description = tools[0].description ?? "";
  assert.match(description, /get_customer: \(input:/);
  assert.match(description, /Example: async \(\) => codemode\.get_customer/);
  assert.doesNotMatch(description, /list_orders|update_order/);
});

test("code description preserves literal template markers in upstream text", async (t) => {
  const upstream = new McpServer({ name: "fixture", version: "1" });
  upstream.registerTool("lookup", { description: "Literal tokens: {{example}} and {{types}}" },
    async () => ({ content: [{ type: "text", text: "fixture" }] }));
  const client = await connect(await createCodeModeMcpServer({ upstream, policy: { read: ["lookup"] } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools[0].description?.includes("Literal tokens: {{example}} and {{types}}"));
  assert.match(tools[0].description ?? "", /Example: async \(\) => codemode\.lookup/);
});

test("code tool reports a serialization failure as an MCP tool error", async (t) => {
  const upstream = ordersServer().server;
  const client = await connect(await createCodeModeMcpServer({
    upstream, policy: { read: ["list_orders"] },
    executor: { async execute() { return { result: 1n, logs: [] }; } },
  }));
  t.after(() => client.close());
  const result = await code(client, "async () => 1");
  assert.equal(result.isError, true);
  assert.match(result.text, /^Error: result not serializable:/);
});

test("code tool preserves scalar result text over MCP", async (t) => {
  const server = await createCodeModeMcpServer({
    upstream: ordersServer().server, policy: { read: ["list_orders"] }, isolation: "inline",
  });
  const client = await connect(server);
  t.after(() => client.close());
  for (const expected of ["undefined", "null", "false", "0", '"ready"']) {
    assert.deepEqual(await code(client, `async () => ${expected}`), { isError: false, text: expected });
  }
});

test("same recipe reused on two different MCP servers (orders + tickets)", async () => {
  const oc: Counters = { calls: {}, writes: [] }, tc: Counters = { calls: {}, writes: [] };
  const orders = await connect(await createCodeModeMcpServer({ upstream: ordersServer(oc).server, policy: { read: ["list_orders"] } }));
  const tickets = await connect(await createCodeModeMcpServer({ upstream: ticketsServer(tc).server, policy: { read: ["search_tickets"] } }));

  const o = await code(orders, paginatedFilter.build({ listTool: "list_orders", where: { status: "pending" }, fields: ["id", "total"], groupBy: "customerId", sample: 2 }));
  assert.equal(o.isError, false, o.text);
  const oj = JSON.parse(o.text);
  assert.equal(oj.data.count, ORDERS.filter((x) => x.status === "pending").length);
  assert.deepEqual(oj.data.sample, ORDERS.filter((x) => x.status === "pending").slice(0, 2).map(({ id, total }) => ({ id, total })));
  assert.equal(oc.calls.list_orders, 5);

  const t = await code(tickets, paginatedFilter.build({ listTool: "search_tickets", cursorArg: "page_token", itemsField: "results", nextField: "nextPageToken", where: { state: "open", priority: "urgent" }, fields: ["ticketId"] }));
  assert.equal(t.isError, false, t.text);
  const tj = JSON.parse(t.text);
  assert.equal(tj.data.count, TICKETS.filter((x) => x.state === "open" && x.priority === "urgent").length);
  assert.equal(tc.calls.search_tickets, 5);
  // bulky fields never reach the model
  assert.ok(!o.text.includes("xxxxxxxxxx") && !t.text.includes("lorem"));
});

test("dependent + parallel composition through MCP, with upstream isError surfacing as a catchable exception", async () => {
  const c: Counters = { calls: {}, writes: [] };
  const client = await connect(await createCodeModeMcpServer({ upstream: ordersServer(c, { failCustomer: "c-4" }).server, policy: { read: ["list_orders", "get_customer"] } }));
  const r = await code(client, `async () => {
    const page = await codemode.list_orders({ status: "pending" });
    const ids = [...new Set(page.items.map((o) => o.customerId))];
    const res = helpers.settle(await helpers.parallel(ids.map((id) => () => codemode.get_customer({ id }))));
    return { gold: res.values.filter((x) => x.tier === "gold").map((x) => x.id), errors: res.errors.length };
  }`);
  assert.equal(r.isError, false, r.text);
  const j = JSON.parse(r.text);
  assert.equal(j.errors, 1);
  assert.ok(j.gold.includes("c-1"));
});

test("policy is enforced through MCP: writes blocked, then allowed with approval", async () => {
  const c: Counters = { calls: {}, writes: [] };
  const denied = await connect(await createCodeModeMcpServer({ upstream: ordersServer(c).server, policy: { read: ["list_orders"], write: ["update_order"] } }));
  const r = await code(denied, `async () => codemode.update_order({ id: "o-1", status: "cancelled" })`);
  assert.equal(r.isError, true);
  assert.match(r.text, /no approval hook/);
  assert.equal(c.writes.length, 0);

  const c2: Counters = { calls: {}, writes: [] };
  const approved = await connect(await createCodeModeMcpServer({ upstream: ordersServer(c2).server, policy: { read: [], write: ["update_order"], approve: ({ args }) => (args as { id: string }).id === "o-1" } }));
  assert.equal((await code(approved, `async () => codemode.update_order({ id: "o-1", status: "cancelled" })`)).isError, false);
  assert.equal((await code(approved, `async () => codemode.update_order({ id: "o-2", status: "cancelled" })`)).isError, true);
  assert.equal(c2.writes.length, 1);
  // unclassified read is also blocked
  assert.match((await code(approved, `async () => codemode.list_orders({})`)).text, /not classified/);
});

test("sandbox escape attempts through the MCP code tool fail", async () => {
  const client = await connect(await createCodeModeMcpServer({ upstream: ordersServer().server, policy: { read: ["list_orders"] }, executorOptions: { timeoutMs: 1_000 } }));
  const r = await code(client, `async () => [typeof process, typeof require, (function(){ return this.constructor.constructor("return typeof process")() })()]`);
  assert.deepEqual(JSON.parse(r.text), ["undefined", "undefined", "undefined"]);
  assert.match((await code(client, "async () => { for(;;){} }")).text, /timed out/);
});

test("real stdio MCP server process (examples/mcp-server) works end to end", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../examples/mcp-server/server.ts", import.meta.url)), "orders"],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => { stderr += String(d); });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["code"]);
    const r = await code(client, paginatedFilter.build({ listTool: "list_orders", where: { status: "shipped" }, fields: ["id"], sample: 1 }));
    assert.equal(JSON.parse(r.text).data.count, ORDERS.filter((x) => x.status === "shipped").length);
    const w = await code(client, `async () => codemode.update_order({ id: "o-1", status: "cancelled" })`);
    assert.equal(w.isError, true);
  } finally {
    await client.close();
  }
  const audits = stderr.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).audit);
  assert.ok(audits.some((a) => a.tool === "list_orders" && a.decision === "allowed"));
  assert.ok(audits.some((a) => a.tool === "update_order" && a.decision === "denied"));
});
