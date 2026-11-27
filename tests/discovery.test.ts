import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from "../src/mcp.ts";
import { searchTools, typesFor } from "../src/index.ts";
import { jsonSchemaToType, jsonSchemaToTypeString } from "../src/vendor/cf-json-schema-types.ts";
import { bigCatalogServer } from "./fixtures/big-catalog.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONSchema7 } from "json-schema";

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

test("progressive discovery keeps the initial tool context small vs. all-types-in-description", async (t) => {
  const full = await connect(await createCodeModeMcpServer({ upstream: bigCatalogServer(80).server, policy: { read: ["*"] } }));
  t.after(() => full.close());
  const prog = await connect(await createSearchExecuteMcpServer({ upstream: bigCatalogServer(80).server, policy: { read: ["*"] } }));
  t.after(() => prog.close());
  const fullTools = (await full.listTools()).tools, progTools = (await prog.listTools()).tools;
  assert.equal((fullTools[0].description ?? "").match(/: \(input:/g)?.length, 83);
  assert.match(progTools.find((tool) => tool.name === "search_tools")?.description ?? "", /among 83 available/);
  const fullChars = JSON.stringify(fullTools).length, progChars = JSON.stringify(progTools).length;
  const ratio = fullChars / progChars;
  t.diagnostic(`listTools chars: code=${fullChars} searchExecute=${progChars} full/progressive=${ratio.toFixed(2)}x`);
  assert.ok(ratio >= 20, `Expected at least 20x smaller initial tool context; observed ${ratio.toFixed(2)}x`);
});

function collectModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:^|\s)(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

test("root entrypoint graph (src/index.ts -> src/discovery-core.ts) has zero MCP or Zod imports", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const corePath = resolve(srcDir, "discovery-core.ts");
  const coreSource = readFileSync(corePath, "utf8");
  const coreSpecs = collectModuleSpecifiers(coreSource);
  for (const spec of coreSpecs) {
    assert.ok(
      spec !== "zod" && !spec.startsWith("zod/") && spec !== "@modelcontextprotocol/sdk" && !spec.startsWith("@modelcontextprotocol/sdk/") && !spec.startsWith("node:") && !spec.endsWith("mcp-resources.ts"),
      `Forbidden import ${spec} in src/discovery-core.ts`,
    );
  }

  const visited = new Set<string>();
  const queue = [resolve(srcDir, "index.ts")];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of collectModuleSpecifiers(source)) {
      assert.ok(
        spec !== "zod" && !spec.startsWith("zod/") && spec !== "@modelcontextprotocol/sdk" && !spec.startsWith("@modelcontextprotocol/sdk/"),
        `Root entrypoint graph must not import ${spec} (found in ${file})`,
      );
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
      }
    }
  }
  assert.ok(visited.has(corePath), "src/index.ts graph must include src/discovery-core.ts");
});

test("typesFor keeps valid sibling properties alongside an unspecified property schema", () => {
  const inputSchema = { type: "object", properties: { a: null, b: { type: "string" } } };
  for (const tools of [
    [{ name: "t", inputSchema }],
    [{ name: "get-item", inputSchema }, { name: "get_item" }],
  ]) {
    const types = typesFor(tools);
    assert.match(types, /a\?: unknown;/);
    assert.match(types, /b\?: string;/);
  }
});

test("typesFor isolates a schema reader error when tool names collide", () => {
  const types = typesFor([
    { name: "get-item", inputSchema: { get type() { throw new Error("Fixture schema unavailable"); } } },
    { name: "get_item", inputSchema: { type: "string" } },
  ]);
  assert.match(types, /^type Tool0Input = unknown$/m);
  assert.match(types, /^type Tool1Input = string$/m);
  assert.match(types, /"get-item": \(input: Tool0Input\)/);
  assert.match(types, /"get_item": \(input: Tool1Input\)/);
});

test("typesFor skips non-array schema metadata and preserves boolean and null types", () => {
  const ignored = { anyOf: {}, oneOf: {}, allOf: {}, enum: {}, required: {} };
  const types = typesFor([{ name: "t", inputSchema: {
    ...ignored,
    properties: {
      a: true,
      b: { $ref: "#/definitions/empty" },
      c: { type: "null" },
      d: { type: "array", items: false },
    },
    definitions: { empty: false },
  } }]);
  assert.match(types, /a\?: unknown;/);
  assert.match(types, /b\?: never;/);
  assert.match(types, /c\?: null;/);
  assert.match(types, /d\?: Array<never>;/);
});

test("schema conversion enforces small visit and text budgets", () => {
  const root: JSONSchema7 = { type: "string" };
  const context = { root, depth: 0, seen: new Set<unknown>(), maxDepth: 5, budget: { remaining: 0 } };
  assert.equal(jsonSchemaToTypeString(root, "", context), "unknown");
  assert.equal(jsonSchemaToTypeString(false, "", context), "never");

  const output = { remaining: 20 };
  const repeated = { ...context, budget: { remaining: 1 }, memo: new Map(), output };
  assert.equal(jsonSchemaToTypeString(root, "", repeated), "string");
  assert.equal(jsonSchemaToTypeString(root, "", repeated), "string");
  output.remaining = 5;
  assert.equal(jsonSchemaToTypeString(root, "", repeated), "unknown");
});

test("schema conversion renders a shared acyclic type across ten graph layers", () => {
  // Count root and leaf as graph layers. Reference wrappers still consume
  // renderer depth; a linear-size example keeps this check about compatibility.
  const definitions: NonNullable<JSONSchema7["definitions"]> = { layer9: { type: "string" } };
  for (let level = 8; level > 0; level--) {
    definitions[`layer${level}`] = { anyOf: [
      { const: level },
      { $ref: `#/definitions/layer${level + 1}` },
    ] };
  }
  const root: JSONSchema7 = {
    definitions,
    anyOf: [{ $ref: "#/definitions/layer1" }, { $ref: "#/definitions/layer1" }],
  };
  const branch = "1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | string";
  assert.equal(jsonSchemaToType(root, "Result"), `type Result = ${branch} | ${branch}`);
});

test("schema conversion preserves the depth cutoff regardless of shared-reference order", () => {
  const shallow = { $ref: "#/definitions/leaf" };
  const deep = { $ref: "#/definitions/wrapper" };
  for (const [anyOf, expected] of [
    [[deep, shallow], "unknown | string"],
    [[shallow, deep], "string | unknown"],
  ] as const) {
    const root: JSONSchema7 = {
      anyOf: [...anyOf],
      definitions: {
        wrapper: { $ref: "#/definitions/intermediate" },
        intermediate: shallow,
        leaf: { type: "string" },
      },
    };
    const context = { root, depth: 0, seen: new Set<unknown>(), maxDepth: 4, memo: new Map(), unsafe: { count: 0 } };
    assert.equal(jsonSchemaToTypeString(root, "", context), expected);
  }
});
