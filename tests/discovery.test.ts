import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from "../src/mcp.ts";
import { searchTools, typesFor } from "../src/index.ts";
import { bigCatalogServer } from "./fixtures/big-catalog.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function connect(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(a);
  return c;
}
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

test("searchTools ranks by name/description tokens and handles snake/camel case", () => {
  const cat = [
    { name: "list_orders", description: "List orders" },
    { name: "getCustomer", description: "Fetch a customer record" },
    { name: "calendar_x", description: "calendar stuff" },
  ];
  assert.deepEqual(searchTools(cat, "customer").map((t) => t.name), ["getCustomer"]);
  assert.deepEqual(searchTools(cat, "orders for a customer", 2).map((t) => t.name).sort(), ["getCustomer", "list_orders"]);
  assert.equal(searchTools(cat, "zzz").length, 0);
  assert.match(typesFor([{ name: "getCustomer", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }]), /getCustomer: \(input: GetCustomerInput\)/);
});

test("search/execute server: discovery returns only relevant types, execute runs under policy", async () => {
  const client = await connect(await createSearchExecuteMcpServer({ upstream: bigCatalogServer(80).server, policy: { read: ["list_orders", "get_customer"] } }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["execute", "search_tools"]);

  const found = text(await client.callTool({ name: "search_tools", arguments: { query: "customer orders", limit: 3 } }));
  assert.match(found, /list_orders/);
  assert.match(found, /get_customer/);
  assert.doesNotMatch(found, /payroll_action/);

  const r = await client.callTool({ name: "execute", arguments: { code: "async () => (await codemode.get_customer({ id: 'c-1' })).tier" } });
  assert.equal(text(r), '"gold"');
  const denied = await client.callTool({ name: "execute", arguments: { code: "async () => codemode.payroll_action_3({ id: 'x' })" } });
  assert.equal((denied as { isError?: boolean }).isError, true);
});

test("progressive discovery keeps the initial tool context small vs. all-types-in-description", async () => {
  const full = await connect(await createCodeModeMcpServer({ upstream: bigCatalogServer(80).server, policy: { read: [] } }));
  const prog = await connect(await createSearchExecuteMcpServer({ upstream: bigCatalogServer(80).server, policy: { read: [] } }));
  const size = async (c: Client) => JSON.stringify((await c.listTools()).tools).length;
  const fullChars = await size(full), progChars = await size(prog);
  const ratio = fullChars / progChars;
  console.log(`listTools chars: codeMcpServer=${fullChars} searchExecute=${progChars} full/progressive=${ratio.toFixed(2)}x`);
  assert.ok(ratio >= 20, `Expected at least 20x smaller initial tool context; observed ${ratio.toFixed(2)}x`);
});
