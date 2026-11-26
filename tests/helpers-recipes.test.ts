import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodeRunner, paginatedFilter, fanOutEnrich, guardedBulkUpdate } from "../src/index.ts";

test("helpers.parallel bounds concurrency and keeps partial results", async () => {
  let active = 0, peak = 0;
  const runner = createCodeRunner({
    tools: { t: { work: async (a) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; if ((a as { i: number }).i === 2) throw new Error("bad 2"); return (a as { i: number }).i; } } },
    policy: { read: ["work"] },
  });
  const r = await runner.run("async () => helpers.settle(await helpers.parallel([0,1,2,3,4,5].map((i) => () => t.work({ i })), { concurrency: 2 }))");
  assert.deepEqual(r.result, { values: [0, 1, 3, 4, 5], errors: [{ index: 2, error: "bad 2" }], complete: false });
  assert.equal(peak, 2);
});

test("helpers.paginate stops at maxPages and flags truncation; retry and data shaping", async () => {
  let flaky = 0;
  const runner = createCodeRunner({
    tools: { t: {
      page: async (a) => { const c = Number((a as { c?: string }).c ?? 0); return { items: [c, c + 1], next: c < 8 ? String(c + 2) : null }; },
      flaky: async () => { if (++flaky < 3) throw new Error("transient"); return "ok"; },
    } },
    policy: { read: ["page", "flaky"] },
  });
  const full = await runner.run("async () => helpers.paginate((c) => t.page(c == null ? {} : { c }))");
  assert.deepEqual(full.result, { items: [0,1,2,3,4,5,6,7,8,9], pages: 5, truncated: false });
  const cut = await runner.run("async () => helpers.paginate((c) => t.page(c == null ? {} : { c }), { maxPages: 2 })");
  assert.deepEqual(cut.result, { items: [0,1,2,3], pages: 2, truncated: true });
  assert.equal((await runner.run("async () => helpers.retry(() => t.flaky(), { attempts: 3 })")).result, "ok");
  const shaped = await runner.run(`async () => {
    const rows = [{ a: 1, b: { c: 2 }, k: "x" }, { a: 2, b: { c: 3 }, k: "y" }, { a: 3, b: { c: 4 }, k: "x" }];
    return { pick: helpers.pick(rows, ["a", "b.c"]), where: helpers.where(rows, { k: "x", a: (v) => v > 1 }).length,
      sum: helpers.summarize(rows, { sample: 1 }), count: helpers.countBy(rows, "k"),
      req: (() => { try { helpers.requireFields({ a: 1 }, ["a", "z"]); } catch (e) { return e.message; } })() };
  }`);
  assert.deepEqual(shaped.result, {
    pick: [{ a: 1, "b.c": 2 }, { a: 2, "b.c": 3 }, { a: 3, "b.c": 4 }], where: 1,
    sum: { count: 3, sample: [{ a: 1, b: { c: 2 }, k: "x" }], omitted: 2 }, count: { x: 2, y: 1 }, req: "Missing required fields: z",
  });
});

test("recipes reject non-identifier tool names (no code injection through params)", () => {
  assert.throws(() => paginatedFilter.build({ listTool: "x(); evil()" }), /must be a JS identifier/);
  // values are JSON-embedded, so this is data, not code:
  assert.doesNotThrow(() => paginatedFilter.build({ listTool: "ok", where: { status: "'); evil(); ('" } }));
});

test("fanOutEnrich and guardedBulkUpdate on in-process tools", async () => {
  const written: unknown[] = [];
  const runner = createCodeRunner({
    tools: { codemode: {
      list: async () => ({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      detail: async (a) => { const id = (a as { key: number }).key; if (id === 2) throw new Error("gone"); return { id, name: "n" + id, secret: "s" }; },
      set: async (a) => { written.push(a); return true; },
    } },
    policy: { read: ["list", "detail"], write: ["set"], approve: () => true },
  });
  const fan = await runner.run(fanOutEnrich.build({ listTool: "list", idField: "id", detailTool: "detail", detailArg: "key", fields: ["id", "name"] }));
  assert.deepEqual((fan.result as { data: unknown }).data, [{ id: 1, name: "n1" }, { id: 3, name: "n3" }]);
  assert.deepEqual((fan.result as { errors: unknown }).errors, [{ id: 2, error: "gone" }]);

  const dry = await runner.run(guardedBulkUpdate.build({ findTool: "list", idField: "id", updateTool: "set", idArg: "id", patch: { flag: true } }));
  assert.equal((dry.result as { dryRun: boolean }).dryRun, true);
  assert.equal(written.length, 0);
  const capped = await runner.run(guardedBulkUpdate.build({ findTool: "list", idField: "id", updateTool: "set", idArg: "id", patch: {}, maxWrites: 2, dryRun: false }));
  assert.equal((capped.result as { ok: boolean }).ok, false);
  assert.equal(written.length, 0);
  const real = await runner.run(guardedBulkUpdate.build({ findTool: "list", idField: "id", updateTool: "set", idArg: "id", patch: { flag: true }, dryRun: false }));
  assert.deepEqual((real.result as { data: unknown }).data, { applied: [1, 2, 3] });
  assert.deepEqual(written, [{ id: 1, flag: true }, { id: 2, flag: true }, { id: 3, flag: true }]);
});
