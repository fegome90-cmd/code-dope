import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { QuickJSExecutor, withPolicy, createAuditLog, createCodeRunner } from "../src/index.ts";

const writes: unknown[] = [];
const fns = {
  read_a: async () => "A",
  write_b: async (a: unknown) => { writes.push(a); return "B"; },
  secret: async () => "should never run",
  slow: () => new Promise((r) => setTimeout(() => r("late"), 5_000)),
  huge: async () => "z".repeat(5_000),
};
const base = new QuickJSExecutor({ timeoutMs: 5_000 });

test("unclassified tools are denied (fail-closed)", async () => {
  const ex = withPolicy(base, { read: ["read_a"] });
  const r = await ex.execute("async () => codemode.secret()", fns);
  assert.match(r.error ?? "", /not classified/);
});

test("write tools are denied without an approval hook, and when approval is rejected", async () => {
  writes.length = 0;
  assert.match((await withPolicy(base, { write: ["write_b"] }).execute("async () => codemode.write_b({n:1})", fns)).error ?? "", /no approval hook/);
  assert.match((await withPolicy(base, { write: ["write_b"], approve: () => false }).execute("async () => codemode.write_b({n:1})", fns)).error ?? "", /approval rejected/);
  assert.equal(writes.length, 0);
});

test("approval is evaluated per call with the actual arguments", async () => {
  writes.length = 0;
  const seen: unknown[] = [];
  const ex = withPolicy(base, { write: ["write_b"], approve: ({ args }) => { seen.push(args); return (args as { n: number }).n < 2; } });
  const r = await ex.execute(`async () => {
    const out = [];
    for (const n of [0, 1, 2, 3]) { try { await codemode.write_b({ n }); out.push(n); } catch (e) { out.push("denied:" + n); } }
    return out;
  }`, fns);
  assert.deepEqual(r.result, [0, 1, "denied:2", "denied:3"]);
  assert.deepEqual(writes, [{ n: 0 }, { n: 1 }]);
  assert.equal(seen.length, 4);
});

test("deny list wins over classification; provider-qualified names work", async () => {
  const ex = withPolicy(base, { read: ["*"], deny: ["crm.read_a"] });
  assert.match((await ex.execute("async () => crm.read_a()", [{ name: "crm", fns }])).error ?? "", /deny list/);
  assert.equal((await ex.execute("async () => other.read_a()", [{ name: "other", fns }])).result, "A");
});

test("argument validation: function validators and zod schemas", async () => {
  const ex = withPolicy(base, {
    read: ["read_a"], write: ["write_b"], approve: () => true,
    validate: { read_a: (a) => (a && typeof a === "object" ? true : "expected an object"), write_b: z.object({ n: z.number().int().min(0) }) },
  });
  assert.match((await ex.execute("async () => codemode.read_a('x')", fns)).error ?? "", /expected an object/);
  assert.match((await ex.execute("async () => codemode.write_b({ n: -1 })", fns)).error ?? "", /invalid arguments/);
  assert.equal((await ex.execute("async () => codemode.write_b({ n: 5 })", fns)).result, "B");
});

test("call budget, per-call timeout and result-size cap", async () => {
  const ex = withPolicy(base, { read: ["read_a", "slow", "huge"], maxCalls: 3, callTimeoutMs: 200, maxResultChars: 1_000 });
  const r = await ex.execute("async () => { const out = []; for (let i = 0; i < 5; i++) { try { out.push(await codemode.read_a()); } catch (e) { out.push('x'); } } return out; }", fns);
  assert.deepEqual(r.result, ["A", "A", "A", "x", "x"]);
  assert.match((await ex.execute("async () => codemode.slow()", fns)).error ?? "", /timed out after 200ms/);
  assert.match((await ex.execute("async () => codemode.huge()", fns)).error ?? "", /limit 1000/);
});

test("budget is per execution, not global", async () => {
  const ex = withPolicy(base, { read: ["read_a"], maxCalls: 1 });
  assert.equal((await ex.execute("async () => codemode.read_a()", fns)).result, "A");
  assert.equal((await ex.execute("async () => codemode.read_a()", fns)).result, "A");
});

test("audit records allowed, denied and failed calls", async () => {
  const log = createAuditLog();
  const ex = withPolicy(base, { read: ["read_a", "slow"], callTimeoutMs: 50, audit: log.sink });
  await ex.execute("async () => { await codemode.read_a(); try { await codemode.secret(); } catch {} try { await codemode.slow(); } catch {} }", fns);
  assert.deepEqual(log.records.map((r) => [r.tool, r.decision, r.ok ?? null]), [["read_a", "allowed", true], ["secret", "denied", null], ["slow", "allowed", false]]);
  assert.deepEqual(log.summary(), { calls: 2, denied: 1, errors: 1, resultChars: 3 });
});

test("connector bindings (which would bypass the wrappers) are refused", async () => {
  const ex = withPolicy(base, { read: ["*"] });
  const r = await ex.execute("async () => 1", fns, { connectors: [{ name: "x", binding: { callTool: async () => 1 } }] });
  assert.match(r.error ?? "", /bypass the policy layer/);
});

test("createCodeRunner returns result + audit", async () => {
  const runner = createCodeRunner({ tools: { crm: { read_a: () => "A" } }, policy: { read: ["read_a"] } });
  const r = await runner.run("async () => crm.read_a()");
  assert.equal(r.result, "A");
  assert.equal(r.audit.length, 1);
});
