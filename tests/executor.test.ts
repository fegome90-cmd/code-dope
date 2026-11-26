import { test } from "node:test";
import assert from "node:assert/strict";
import { QuickJSExecutor, SANDBOX_HELPERS } from "../src/index.ts";

const ex = new QuickJSExecutor({ timeoutMs: 1500 });
const fns = {
  add: async (a: unknown) => { const { x, y } = a as { x: number; y: number }; return x + y; },
  echo: async (a: unknown) => a,
  slow: () => new Promise((r) => setTimeout(() => r(1), 10_000)),
  fail: async () => { throw new Error("upstream exploded"); },
  bigint: async () => ({ toJSON() { throw new Error("nope"); } }),
};

test("runs async arrow functions and composes tool calls (sequential + parallel)", async () => {
  const r = await ex.execute(`async () => {
    const a = await codemode.add({ x: 1, y: 2 });
    const [b, c] = await Promise.all([codemode.add({ x: a, y: 1 }), codemode.add({ x: a, y: 2 })]);
    console.log("done", { b, c });
    return { a, b, c };
  }`, fns);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.result, { a: 3, b: 4, c: 5 });
  assert.deepEqual(r.logs, ['done {"b":4,"c":5}']);
});

test("normalizes bare statements and fenced code (vendored Cloudflare normalizeCode)", async () => {
  assert.equal((await ex.execute("const r = await codemode.add({x:2,y:2}); return r * 10;", fns)).result, 40);
  assert.equal((await ex.execute("```js\nasync () => 7\n```", fns)).result, 7);
});

test("undefined result and JSON round-trip", async () => {
  assert.equal((await ex.execute("async () => {}", fns)).result, undefined);
  assert.deepEqual((await ex.execute("async () => codemode.echo({ a: [1, { b: null }] })", fns)).result, { a: [1, { b: null }] });
});

test("sandbox has no Node, network or host globals", async () => {
  const r = await ex.execute(`async () => ({
    process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout,
    viaCtor: (function(){ return this.constructor.constructor("return typeof process")(); })(),
    viaFn: Function("return typeof globalThis.process + typeof globalThis.require")(),
    bridgeHidden: typeof __cd_host + typeof __cd_log,
    importFails: await import("node:fs").then(() => "loaded", (e) => "blocked"),
  })`, fns);
  assert.deepEqual(r.result, {
    process: "undefined", require: "undefined", fetch: "undefined", setTimeout: "undefined",
    viaCtor: "undefined", viaFn: "undefinedundefined", bridgeHidden: "undefinedundefined", importFails: "blocked",
  });
});

test("tool function objects never reach the guest (only JSON crosses)", async () => {
  const r = await ex.execute(`async () => { const f = codemode.add; return [typeof f, f.constructor.constructor === Function, String(codemode.then)]; }`, fns);
  assert.deepEqual(r.result, ["function", true, "undefined"]);
});

test("CPU-bound loops are interrupted", async () => {
  const r = await ex.execute("async () => { while (true) {} }", fns);
  assert.match(r.error ?? "", /timed out/);
});

test("idle waits on slow tools are bounded by wall-clock timeout", async () => {
  const t = Date.now();
  const r = await ex.execute("async () => codemode.slow()", fns);
  assert.match(r.error ?? "", /timed out/);
  assert.ok(Date.now() - t < 3000);
});

test("memory limit is enforced", async () => {
  const small = new QuickJSExecutor({ timeoutMs: 20_000, memoryLimitBytes: 4 * 1024 * 1024 });
  const r = await small.execute("async () => { const a = []; for (let i = 0; ; i++) a.push(new Array(1e4).fill(i)); }", {});
  assert.match(r.error ?? "", /out of memory/);
});

test("errors are returned, never thrown: unknown tool, tool failure, guest throw, syntax error, non-JSON result", async () => {
  assert.match((await ex.execute("async () => codemode.nope({})", fns)).error ?? "", /Unknown tool: codemode.nope/);
  assert.match((await ex.execute("async () => codemode.fail()", fns)).error ?? "", /upstream exploded/);
  assert.equal((await ex.execute("async () => { try { await codemode.fail(); } catch (e) { return 'caught:' + e.message; } }", fns)).result, "caught:upstream exploded");
  assert.match((await ex.execute("async () => { throw new Error('boom') }", fns)).error ?? "", /boom/);
  assert.ok((await ex.execute("async () => { return ( }", fns)).error);
  assert.match((await ex.execute("async () => codemode.bigint()", fns)).error ?? "", /not JSON-serializable/);
});

test("prototype-ish tool names cannot reach host internals", async () => {
  for (const name of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
    const r = await ex.execute(`async () => codemode[${JSON.stringify(name)}]({})`, fns);
    assert.ok(r.error, `expected error for ${name}`);
  }
});

test("console output is capped", async () => {
  const capped = new QuickJSExecutor({ maxLogLines: 5, maxLogLineChars: 10 });
  const r = await capped.execute("async () => { for (let i = 0; i < 1000; i++) console.log('line-' + i + '-' + 'y'.repeat(50)); return 1; }", {});
  assert.equal(r.logs?.length, 5);
  assert.ok(r.logs?.[0].endsWith("…[truncated]"));
});

test("multiple named providers and preludes", async () => {
  const withHelpers = new QuickJSExecutor({ preludes: [SANDBOX_HELPERS] });
  const r = await withHelpers.execute("async () => [await crm.echo({ id: 1 }), typeof helpers.parallel, typeof codemode]", [
    { name: "crm", fns },
  ]);
  assert.deepEqual(r.result, [{ id: 1 }, "function", "undefined"]);
  assert.match((await ex.execute("async () => 1", [{ name: "console", fns }])).error ?? "", /Invalid provider name/);
});

test("executions are isolated from each other", async () => {
  await ex.execute("async () => { globalThis.leak = 42; }", fns);
  assert.equal((await ex.execute("async () => typeof leak", fns)).result, "undefined");
});
