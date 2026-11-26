/** Regression tests for the independent Sonnet review (S3). IDs match RESEARCH.md §8. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QuickJSExecutor, WorkerExecutor, withPolicy, createAuditLog, createCodeRunner, guardedBulkUpdate, paginatedFilter, searchTools } from "../src/index.ts";
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from "../src/mcp.ts";

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
async function connect(s: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(b);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(a);
  return c;
}
function hyphenServer(calls: string[]) {
  const s = new McpServer({ name: "h", version: "1" });
  s.registerTool("get-user", { description: "Get a user", inputSchema: { id: z.string() } }, async ({ id }) => { calls.push("get-user"); return { content: [{ type: "text" as const, text: JSON.stringify({ id }) }] }; });
  s.registerTool("delete-user", { description: "Delete a user", inputSchema: { id: z.string() } }, async () => { calls.push("delete-user"); return { content: [{ type: "text" as const, text: "deleted" }] }; });
  return s;
}

test("C1: repeated guest stack overflows do not poison later executions", async () => {
  const ex = new QuickJSExecutor({ timeoutMs: 3_000 });
  for (let i = 0; i < 20; i++) assert.ok((await ex.execute("async () => { function f() { f(); } f(); }", {})).error);
  assert.equal((await ex.execute("async () => 1", {})).result, 1);
  assert.equal((await new QuickJSExecutor().execute("async () => 2", {})).result, 2);
});

test("H1: call budget holds under concurrent calls with an async approver", async () => {
  let executed = 0;
  const ex = withPolicy(new QuickJSExecutor(), { write: ["w"], maxCalls: 1, approve: () => new Promise((r) => setTimeout(() => r(true), 20)) });
  await ex.execute("async () => Promise.allSettled(Array.from({ length: 10 }, () => codemode.w({})))", { w: async () => { executed++; return 1; } });
  assert.equal(executed, 1);
});

test("H2: deny/validate written with original (hyphenated) names apply in the search/execute server", async () => {
  const calls: string[] = [];
  const c = await connect(await createSearchExecuteMcpServer({ upstream: hyphenServer(calls), policy: { read: ["*"], deny: ["delete-user"], validate: { "get-user": (a) => ((a as { id: string }).id === "ok" ? true : "bad id") } } }));
  const del = await c.callTool({ name: "execute", arguments: { code: "async () => codemode.delete_user({ id: 'victim' })" } });
  assert.match(text(del), /deny list/);
  const bad = await c.callTool({ name: "execute", arguments: { code: "async () => codemode.get_user({ id: 'x' })" } });
  assert.match(text(bad), /bad id/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(text(await c.callTool({ name: "search_tools", arguments: { query: "delete user" } })), /delete_user/);
});

test("M1: sanitized names advertised by codeMcpServer resolve to hyphenated upstream tools", async () => {
  const calls: string[] = [];
  const c = await connect(await createCodeModeMcpServer({ upstream: hyphenServer(calls), policy: { read: ["get-user"] } }));
  const r = await c.callTool({ name: "code", arguments: { code: "async () => codemode.get_user({ id: 'u1' })" } });
  assert.deepEqual(JSON.parse(text(r)), { id: "u1" });
  assert.match(text(await c.callTool({ name: "code", arguments: { code: "async () => codemode.delete_user({ id: 'u1' })" } })), /not classified/);
  assert.deepEqual(calls, ["get-user"]);
});

test("H3: with WorkerExecutor a CPU-bound guest does not block the host event loop", async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  const r = await new WorkerExecutor({ timeoutMs: 600 }).execute("async () => { for (;;) {} }", {});
  clearInterval(iv);
  assert.match(r.error ?? "", /timed out/);
  assert.ok(ticks >= 10, `only ${ticks} ticks`);
});

test("WorkerExecutor: tools stay in the parent, worker has no inherited env, policy still applies", async () => {
  process.env.CODE_DOPE_TEST_SECRET = "s3cr3t";
  const runner = createCodeRunner({ tools: { t: { env: async () => "from-parent", w: async () => "x" } }, policy: { read: ["env"], write: ["w"] } });
  const r = await runner.run("async () => [await t.env(), typeof process, await t.w().catch((e) => e.message)]");
  assert.deepEqual(r.result, ["from-parent", "undefined", "Denied t.w: write tool and no approval hook configured"]);
  delete process.env.CODE_DOPE_TEST_SECRET;
});

test("M2: audit log is bounded", async () => {
  const log = createAuditLog(100);
  await withPolicy(new QuickJSExecutor({ timeoutMs: 2_000 }), { read: [], audit: log.sink }).execute("async () => { for (let i = 0; i < 1000; i++) { try { await codemode.x(); } catch {} } }", { x: async () => 1 });
  assert.equal(log.records.length, 100);
  assert.equal(log.dropped, 900);
});

test("M3: timed-out calls are audited as outcome unknown", async () => {
  const log = createAuditLog();
  const r = await withPolicy(new QuickJSExecutor(), { write: ["w"], approve: () => true, callTimeoutMs: 30, audit: log.sink }).execute("async () => codemode.w({})", { w: () => new Promise((res) => setTimeout(() => res(1), 200)) });
  assert.match(r.error ?? "", /side effects may still complete/);
  assert.equal(log.records[0].outcome, "unknown");
});

test("M4/M5: throwing hooks are audited denials; hooks cannot mutate the executed args", async () => {
  const log = createAuditLog();
  const seen: unknown[] = [];
  const fns = { w: async (a: unknown) => { seen.push(a); return 1; } };
  await withPolicy(new QuickJSExecutor(), { write: ["w"], approve: () => { throw new Error("approver down"); }, audit: log.sink }).execute("async () => codemode.w({ amount: 1 })", fns);
  assert.equal(log.records[0].decision, "denied");
  assert.match(log.records[0].reason ?? "", /approver down/);
  await withPolicy(new QuickJSExecutor(), { write: ["w"], approve: ({ args }) => { (args as { amount: number }).amount = 1e9; return true; } }).execute("async () => codemode.w({ amount: 1 })", fns);
  assert.deepEqual(seen, [{ amount: 1 }]);
});

test("M7: in-flight tool calls are capped", async () => {
  const r = await new QuickJSExecutor({ maxPendingCalls: 8 }).execute("async () => (await Promise.allSettled(Array.from({ length: 50 }, () => codemode.e({})))).filter((x) => x.status === 'rejected').length", { e: async () => 1 });
  assert.equal(r.result, 42);
});

test("M8/M9: deeply nested results fail cleanly; trailing comments are accepted", async () => {
  const ex = new QuickJSExecutor();
  const deep = await ex.execute("async () => { let o = {}; const root = o; for (let i = 0; i < 20000; i++) { o.a = {}; o = o.a; } return root; }", {});
  assert.ok(deep.error);
  assert.equal((await ex.execute("async () => { return 1 } // done", {})).result, 1);
  assert.equal((await ex.execute("async () => 1\n// done", {})).result, 1);
});

test("L1/L2/L3: recipe guards", async () => {
  assert.throws(() => guardedBulkUpdate.build({ findTool: "f", idField: "id", updateTool: "u", idArg: "id", patch: { id: "HIJACK" } }), /must not contain/);
  assert.throws(() => guardedBulkUpdate.build({ findTool: "f", idField: "id", updateTool: "u", idArg: "id", patch: {}, dryRun: "false" as unknown as boolean }), /boolean/);
  const runner = createCodeRunner({ tools: { codemode: { stuck: async () => ({ items: [1], next: "same" }), none: async () => null } }, policy: { read: ["stuck", "none"] }, isolation: "inline" });
  const r = (await runner.run(paginatedFilter.build({ listTool: "stuck" }))).result as { ok: boolean; truncated: boolean };
  assert.equal(r.ok, false);
  assert.equal(r.truncated, true);
  assert.equal(((await runner.run(guardedBulkUpdate.build({ findTool: "none", idField: "id", updateTool: "stuck", idArg: "id", patch: {} }))).result as { dryRun: boolean }).dryRun, true);
});

test("L4: discovery matches word prefixes and returns nothing for empty queries", () => {
  const cat = [{ name: "list_orders", description: "List all orders" }, { name: "cancelOrder" }];
  assert.deepEqual(searchTools(cat, "order").map((t) => t.name).sort(), ["cancelOrder", "list_orders"]);
  assert.deepEqual(searchTools(cat, "a"), []);
});

test("L7: helpers.retry does not retry policy denials", async () => {
  let approvals = 0;
  const runner = createCodeRunner({ tools: { codemode: { w: async () => 1 } }, policy: { write: ["w"], approve: () => { approvals++; return false; } }, isolation: "inline" });
  await runner.run("async () => helpers.retry(() => codemode.w({}), { attempts: 3 })");
  assert.equal(approvals, 1);
});
