import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodeRunner, createDefaultExecutor, guardFns, guardedBulkUpdate, paginatedFilter, withPolicy, WorkerExecutor, type AuditRecord, type Executor } from "../src/index.ts";
import { createPlugin } from "../examples/plugin-consumer/plugin.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const asyncSink of [false, true]) test(`audit failure preserves completed writes and emits no false failure (async=${asyncSink})`, async () => {
  const records: AuditRecord[] = [];
  let writes = 0;
  const sink = (record: AuditRecord) => { records.push(record); throw new Error("AUDIT_UNAVAILABLE"); };
  const guarded = guardFns("svc", { write: async () => { writes++; return "written"; } }, {
    write: ["write"], approve: () => true, audit: asyncSink ? async (r) => sink(r) : sink,
  });
  assert.equal(await guarded.write({}), "written");
  await sleep(0);
  assert.equal(writes, 1);
  assert.deepEqual(records.map((r) => [r.decision, r.outcome]), [["allowed", "done"]]);
});

test("audit failure cannot replace a policy denial", async () => {
  let calls = 0;
  const guarded = guardFns("svc", { write: async () => { calls++; } }, { audit: () => { throw new Error("AUDIT_UNAVAILABLE"); } });
  await assert.rejects(guarded.write({}), /Denied svc.write: tool is not classified/);
  assert.equal(calls, 0);
});

for (const colliding of [false, true]) test(`provider scope cannot authorize or validate another provider (collision=${colliding})`, async () => {
  const fns: Record<string, () => Promise<string>> = { crm_get: async () => "underscore" };
  if (colliding) fns["crm.get"] = async () => "dotted";
  const scoped = guardFns("mail", fns, { read: ["crm.get"] });
  for (const fn of Object.values(scoped)) await assert.rejects(fn({}), /not classified/);
  const local = colliding ? "mail.crm.get" : "mail.crm_get";
  const guarded = guardFns("mail", fns, {
    read: [local], deny: ["crm.get"], validate: { "crm.get": () => "wrong provider" },
  });
  assert.equal(await guarded[colliding ? "crm.get" : "crm_get"]({}), colliding ? "dotted" : "underscore");
  const rejected = guardFns("mail", fns, { read: [local], validate: { [local]: () => "invalid local input" } });
  await assert.rejects(rejected[colliding ? "crm.get" : "crm_get"]({}), /invalid local input/);
});

test("explicit provider arrays preserve provider scope even for a single dotted tool", async () => {
  const code = "async () => mail['crm.get']({})";
  const mockExecutor: Executor = {
    async execute(source, providers) {
      assert.equal(source, code);
      assert.ok(Array.isArray(providers));
      return { result: await providers[0].fns["crm.get"]({}), logs: [] };
    },
  };
  const result = await withPolicy(mockExecutor, {
    read: ["mail.crm.get"], deny: ["crm.get"], validate: { "crm.get": () => "wrong provider" },
  }).execute(code, [{ name: "mail", fns: { "crm.get": async () => "mail fixture" } }]);
  assert.deepEqual(result, { result: "mail fixture", logs: [] });
});

test("caller, validator and approver cannot mutate the executed argument snapshot", async () => {
  let approve!: (value: boolean) => void;
  let approved: unknown, executed: unknown;
  const gate = new Promise<boolean>((resolve) => { approve = resolve; });
  const args = { nested: { amount: 100 } };
  const guarded = guardFns("svc", { write: async (input) => { executed = input; return "ok"; } }, {
    write: ["write"],
    validate: { write: (input) => { (input as typeof args).nested.amount = 1; return true; } },
    approve: ({ args: input }) => { approved = structuredClone(input); (input as typeof args).nested.amount = 2; return gate; },
  });
  const pending = guarded.write(args);
  args.nested.amount = 3;
  approve(true);
  assert.equal(await pending, "ok");
  assert.deepEqual(approved, { nested: { amount: 100 } });
  assert.deepEqual(executed, { nested: { amount: 100 } });
});

test("helper batch rejects invalid sizes before processing, and preserves valid chunks", async () => {
  const runner = createCodeRunner({ tools: {}, policy: {}, isolation: "inline" });
  const result = await runner.run(`async () => {
    let calls = 0; const errors = [];
    for (const size of [0, -1, 1.5, Infinity, NaN]) {
      try { await helpers.batch([1,2], size, () => { calls++; }); }
      catch (e) { errors.push(e.message); }
    }
    return { calls, errors, valid: await helpers.batch([1,2,3], 2, (chunk) => chunk) };
  }`);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.result, { calls: 0, errors: Array(5).fill("batch size must be a positive integer"), valid: [[1, 2], [3]] });
});

test("custom retry predicate cannot override policy denial", async () => {
  const runner = createCodeRunner({ tools: {}, policy: {}, isolation: "inline" });
  const result = await runner.run(`async () => {
    let calls = 0, predicates = 0, transient = 0;
    try { await helpers.retry(() => { calls++; throw new Error("Denied write"); }, { retryIf: () => { predicates++; return true; } }); } catch {}
    const recovered = await helpers.retry(() => { if (++transient < 2) throw new Error("transient"); return 42; }, { retryIf: () => true });
    return { calls, predicates, transient, recovered };
  }`);
  assert.deepEqual(result.result, { calls: 1, predicates: 0, transient: 2, recovered: 42 });
});

test("group counts preserve property-like names through the recipe result", async () => {
  const runner = createCodeRunner({
    tools: { codemode: { list: async () => ({ items: ["constructor", "__proto__", "toString", "constructor"].map((group) => ({ group })), next: null }) } },
    policy: { read: ["list"] }, isolation: "inline",
  });
  const result = await runner.run(paginatedFilter.build({ listTool: "list", groupBy: "group" }));
  assert.equal(result.error, undefined);
  assert.deepEqual((result.result as { groups: unknown }).groups, JSON.parse('{"constructor":2,"__proto__":1,"toString":1}'));
});

test("bulk recipe separates a timed-out write from unattempted targets", async () => {
  const started: number[] = [], applied: number[] = [];
  const runner = createCodeRunner({
    tools: { codemode: {
      list: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      write: async (args) => { const id = (args as { id: number }).id; started.push(id); if (id === 2) await sleep(80); applied.push(id); return true; },
    } },
    policy: { read: ["list"], write: ["write"], approve: () => true, callTimeoutMs: 25 },
  });
  const result = await runner.run(guardedBulkUpdate.build({ findTool: "list", idField: "id", updateTool: "write", idArg: "id", patch: {}, dryRun: false }));
  assert.equal(result.error, undefined);
  const body = result.result as { ok: boolean; data: { applied: number[]; pending: number[]; stopped: { id: number; error: string; outcome: string } } };
  assert.equal(body.ok, false);
  assert.deepEqual(body.data.applied, [1]);
  assert.deepEqual(body.data.pending, [3]);
  assert.equal(body.data.stopped.id, 2);
  assert.equal(body.data.stopped.outcome, "unknown");
  assert.match(body.data.stopped.error, /timed out/);
  await sleep(100);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(applied, [1, 2], "the timed-out effect can still complete and must not be in pending");
});

test("plugin validates recipe selection and returns build errors in its envelope", async () => {
  const tool = createPlugin({ approveWrites: () => false }).tools[0];
  for (const value of [{}, { recipe: "unknown" }, { recipe: "constructor" }, { code: "async () => 1", recipe: "paginatedFilter" }, { recipe: "paginatedFilter", params: {} }]) {
    const result = await tool.handler(value as Parameters<typeof tool.handler>[0]);
    assert.equal(result.isError, true);
    assert.ok(result.text);
    assert.deepEqual(result.audit, []);
  }
  assert.equal((await tool.handler({ code: "async () => 42" })).text, "42");
});

test("the pool remains opt-in; default execution uses disposable workers", () => {
  assert.ok(createDefaultExecutor() instanceof WorkerExecutor);
});
