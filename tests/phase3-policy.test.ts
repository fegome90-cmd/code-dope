import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFns, withPolicy, createAuditLog, type Executor } from "../src/index.ts";

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
