import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from "../src/mcp.ts";
import { PooledWorkerExecutor, type Executor } from "../src/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const factories = [["code", createCodeModeMcpServer], ["execute", createSearchExecuteMcpServer]] as const;
const tool = (name: string, description = name) => ({ name, description, inputSchema: { type: "object" as const, properties: {} } });
const text = (result: unknown) => (result as { content: Array<{ text?: string }> }).content.map((item) => item.text ?? "").join("\n");

function upstream(mode: "pages" | "repeated" | "failure" = "pages") {
  const server = new McpServer({ name: "synthetic-upstream", version: "1.0.0" });
  server.server.registerCapabilities({ tools: {} });
  const state = { closed: 0, listed: [] as Array<string | undefined>, called: [] as string[] };
  server.server.onclose = () => { state.closed++; };
  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    state.listed.push(cursor);
    if (cursor !== undefined && mode === "failure") throw new Error("CONTROLLED_PAGE_FAILURE");
    if (cursor === undefined) return { tools: [tool("delete-user", "FORBIDDEN_PUNCTUATION_VARIANT")], nextCursor: "second" };
    return { tools: [tool("delete_user", "ALLOWED_UNDERSCORE_VARIANT"), tool("later")], ...(mode === "repeated" ? { nextCursor: "second" } : {}) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    assert.equal(state.closed, 0, "upstream resource must stay open while serving");
    state.called.push(request.params.name);
    return { content: [{ type: "text" as const, text: JSON.stringify(request.params.name) }] };
  });
  return { server, state };
}

async function connect(server: McpServer) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pr2-test", version: "1.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

for (const [entry, factory] of factories) {
  test(`${entry}: output validation and required-task guards survive catalog pagination`, async () => {
    const source = upstream();
    source.server.server.setRequestHandler(ListToolsRequestSchema, async (request) => request.params?.cursor
      ? { tools: [tool("later")] }
      : { tools: [
        { ...tool("typed"), outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } },
        { ...tool("required_task"), execution: { taskSupport: "required" } },
      ], nextCursor: "second" });
    source.server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      source.state.called.push(request.params.name);
      const mode = request.params.arguments?.mode;
      return { content: [{ type: "text", text: "{}" }], ...(mode === "missing" ? {} : { structuredContent: { count: mode === "valid" ? 1 : "invalid" } }) };
    });
    const server = await factory({ upstream: source.server, policy: { read: ["typed", "required_task"] } });
    const client = await connect(server);
    try {
      const result = await client.callTool({ name: entry, arguments: { code: `async () => [
        await codemode.typed({ mode: "valid" }),
        await codemode.typed({ mode: "invalid" }).catch(e => e.message),
        await codemode.typed({ mode: "missing" }).catch(e => e.message),
        await codemode.required_task({}).catch(e => e.message)
      ]` } });
      const values = JSON.parse(text(result));
      assert.deepEqual(values[0], { count: 1 });
      assert.match(values[1], /does not match.*output schema/);
      assert.match(values[2], /did not return structured content/);
      assert.match(values[3], /requires task-based execution/);
      assert.deepEqual(source.state.called, ["typed", "typed", "typed"]);
    } finally { await server.close(); await client.close(); }
  });

  test(`${entry}: one upstream connection, all pages, and cross-page collisions remain exact`, async () => {
    const source = upstream();
    const server = await factory({ upstream: source.server, policy: { read: ["delete_user", "later"] } });
    let client: Client | undefined;
    try {
      assert.equal(source.state.closed, 0, "construction must not fire upstream onclose");
      assert.deepEqual(source.state.listed, [undefined, "second"]);
      client = await connect(server);
      const advertised = entry === "code"
        ? (await client.listTools()).tools[0].description ?? ""
        : text(await client.callTool({ name: "search_tools", arguments: { query: "delete", limit: 10 } }));
      assert.ok(advertised.includes("ALLOWED_UNDERSCORE_VARIANT"));
      assert.ok(!advertised.includes("FORBIDDEN_PUNCTUATION_VARIANT"));
      const result = await client.callTool({ name: entry, arguments: { code: `async () => [await codemode['delete-user']({}).catch(e => e.message), await codemode.delete_user({}), await codemode.later({})]` } });
      const values = JSON.parse(text(result));
      assert.match(values[0], /Denied.*collides/);
      assert.deepEqual(values.slice(1), ["delete_user", "later"]);
      assert.deepEqual(source.state.called, ["delete_user", "later"]);
    } finally { await server.close(); await client?.close(); }
    assert.equal(source.state.closed, 1);
    assert.equal(source.server.server.transport, undefined);
  });

  for (const mode of ["repeated", "failure"] as const) test(`${entry}: ${mode} catalog failure closes its connection and owned pool`, async (t) => {
    const source = upstream(mode);
    const closed: PooledWorkerExecutor[] = [];
    const close = PooledWorkerExecutor.prototype.close;
    t.mock.method(PooledWorkerExecutor.prototype, "close", function (this: PooledWorkerExecutor) {
      return close.call(this).then(() => { closed.push(this); });
    });
    await assert.rejects(factory({ upstream: source.server, policy: {}, isolation: "pool", executorOptions: { size: 1, idleMs: 0 } }), mode === "repeated" ? /repeated a cursor/ : /CONTROLLED_PAGE_FAILURE/);
    assert.equal(source.state.closed, 1);
    assert.equal(source.server.server.transport, undefined);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].stats.alive, 0);
  });

  for (const disconnect of [false, true]) test(`${entry}: owned pool closes on ${disconnect ? "consumer disconnect" : "explicit adapter close"}`, async (t) => {
    const source = upstream();
    const closed: PooledWorkerExecutor[] = [];
    const close = PooledWorkerExecutor.prototype.close;
    t.mock.method(PooledWorkerExecutor.prototype, "close", function (this: PooledWorkerExecutor) {
      return close.call(this).then(() => { closed.push(this); });
    });
    const server = await factory({ upstream: source.server, policy: {}, isolation: "pool", executorOptions: { size: 1, idleMs: 0 } });
    const client = await connect(server);
    try {
      if (disconnect) {
        await client.close();
        const deadline = Date.now() + 3_000;
        while (!closed.length) { assert.ok(Date.now() < deadline, "disconnect did not clean up the pool"); await sleep(10); }
      } else await server.close();
      await server.close();
      assert.equal(closed.length, 1);
      assert.equal(closed[0].stats.alive, 0);
      assert.equal(source.state.closed, 1);
    } finally { await server.close(); await client.close(); }
  });

  test(`${entry}: supplied executor remains caller-owned after close and initialization failure`, async () => {
    const pool = new PooledWorkerExecutor({ size: 1, idleMs: 0, prewarm: false });
    try {
      const server = await factory({ upstream: upstream().server, policy: {}, executor: pool });
      await server.close();
      assert.equal((await pool.execute("async () => 42", {})).result, 42);
      await assert.rejects(factory({ upstream: upstream("failure").server, policy: {}, executor: pool }), /CONTROLLED_PAGE_FAILURE/);
      assert.equal((await pool.execute("async () => 43", {})).result, 43);
    } finally { await pool.close(); }
  });

  test(`${entry}: already-connected upstream is rejected without closing the caller's connection`, async () => {
    const source = upstream();
    const client = await connect(source.server);
    try {
      await assert.rejects(factory({ upstream: source.server, policy: {} }), /already connected/);
      assert.equal(source.state.closed, 0);
      assert.equal(text(await client.callTool({ name: "later", arguments: {} })), '"later"');
    } finally { await client.close(); }
  });
}

test("search/execute enforces the entire response budget for success, errors and serialization failures", async () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const cases: Array<{ executor: Executor; error: boolean }> = [
    { executor: { execute: async () => ({ result: "x".repeat(100_000), logs: [] }) }, error: false },
    { executor: { execute: async () => ({ result: undefined, error: "x".repeat(100_000), logs: [] }) }, error: true },
    { executor: { execute: async () => { throw new Error("x".repeat(100_000)); } }, error: true },
    { executor: { execute: async () => ({ result: cyclic, logs: [] }) }, error: true },
  ];
  for (const maxResponseChars of [0, 1, 10, 1000]) for (const scenario of cases) {
    const server = await createSearchExecuteMcpServer({ upstream: upstream().server, policy: {}, executor: scenario.executor, maxResponseChars });
    const client = await connect(server);
    try {
      const result = await client.callTool({ name: "execute", arguments: { code: "async () => 1" } });
      assert.ok(text(result).length <= maxResponseChars);
      assert.equal(!!result.isError, scenario.error);
    } finally { await server.close(); await client.close(); }
  }
});
