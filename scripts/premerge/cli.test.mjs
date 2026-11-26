import { strict as assert } from "node:assert";
import { test } from "node:test";
import { run } from "./cli.mjs";

test("invalid or excluded PR is stopped before the reader", async () => {
  let reads = 0;
  const collect = () => { reads++; };
  for (const args of [["--pr", "2"], ["--pr", "02"], ["--pr", "3", "--intent", "bypass"], ["--pr", "-1"]]) {
    assert.equal(await run(args, { collect, print() {} }), 2);
  }
  assert.equal(reads, 0);
});

test("a reading failure does not echo details and cannot report ready", async () => {
  const out = [];
  const collect = () => { throw Error("details not for diagnostics"); };
  assert.equal(await run(["--pr", "3"], { collect, print: s => out.push(s) }), 1);
  assert.equal(JSON.parse(out[0]).status, "BLOCKED_EVIDENCE");
  assert.equal(out[0].includes("details not for diagnostics"), false);
});
