import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFns, withPolicy, createAuditLog, typesFor, type Executor } from "../src/index.ts";
import { collisions, policyAllows } from "../src/policy.ts";

for (const rejects of [false, true]) {
  test(`M1: retained guards close in finally when the executor ${rejects ? "rejects" : "resolves"}`, async () => {
    let retained!: Record<string, (...args: unknown[]) => Promise<unknown>>;
    let invoked = 0;
    let approved = 0;
    const log = createAuditLog();
    const inner: Executor = {
      async execute(_code, fns) {
        assert.ok(!Array.isArray(fns));
        retained = fns;
        if (rejects) throw new Error("executor failed");
        return { result: 1, logs: [] };
      },
    };
    const ex = withPolicy(inner, { write: ["w"], approve: () => { approved++; return true; }, audit: log.sink });
    const run = ex.execute("async () => 1", { w: async () => { invoked++; return 1; } });
    if (rejects) await assert.rejects(run, /executor failed/);
    else assert.equal((await run).result, 1);
    await assert.rejects(retained.w({}), /execution already finished/);
    assert.equal(invoked, 0);
    assert.equal(approved, 0);
    assert.equal(log.records[0].decision, "denied");
  });
}

test("M1: standalone guardFns retains its caller-managed lifetime", async () => {
  let signal: AbortSignal | undefined;
  const guarded = guardFns("tools", { w: async () => 42 }, { write: ["w"], approve: (req) => { signal = req.signal; return true; } });
  assert.equal(await guarded.w({}), 42);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(await guarded.w({}), 42);
  assert.equal(signal?.aborted, false);
  const legacy = guardFns("tools", { r: async () => 1 }, { read: ["r"] }, { calls: 0, seq: 0 });
  assert.equal(await legacy.r({}), 1);
});

test("M2: collision detection uses distinct real names and retains every variant", () => {
  assert.deepEqual([...collisions(["one", "one"])], []);
  assert.deepEqual([...collisions(["a-b", "a_b", "a b", "other"])].sort(), ["a b", "a-b", "a_b"]);
});

test("M2: wildcards do not implicitly allow ambiguous names; deny remains broad", async () => {
  const names = ["delete-user", "delete_user"];
  const ambiguous = collisions(names);
  let calls = 0;
  const guarded = guardFns("crm", Object.fromEntries(names.map((name) => [name, async () => ++calls])), { read: ["*"], approve: () => true });
  for (const name of names) {
    assert.equal(policyAllows({ read: ["*"] }, "crm", name, ambiguous), false);
    await assert.rejects(guarded[name]({}), /not classified.*collides/);
    assert.equal(policyAllows({ read: names, deny: ["delete-user"] }, "crm", name, ambiguous), false);
  }
  assert.equal(calls, 0);
  assert.equal(policyAllows({ read: ["*"] }, "crm", "unique", ambiguous), true);
});

test("M2: type generation preserves exact properties and distinct input declarations", () => {
  const catalog = ["delete-user", "delete_user", "delete user"].map((name) => ({ name, inputSchema: { type: "object", properties: { id: { type: "string" } } } }));
  const types = typesFor(catalog);
  const names = [...types.matchAll(/^type (\w+)/gm)].map((m) => m[1]);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  for (const { name } of catalog) assert.ok(types.includes(`${JSON.stringify(name)}: (input:`));
  const subset = typesFor(catalog.slice(0, 1), collisions(catalog.map((t) => t.name)));
  assert.ok(subset.includes('"delete-user": (input:'));
  assert.ok(!subset.includes('"delete_user":'));
});
