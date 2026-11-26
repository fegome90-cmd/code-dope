/**
 * Benchmark: "pending orders of gold-tier customers → ids, totals, sum".
 *
 * Baseline: conventional individual MCP tool calls; every tool result is
 *           returned to the model (as an agent loop would).
 * Candidate: one Code Mode `code` call via createCodeModeMcpServer.
 *
 * MEASURED here: tool invocations, characters of tool output that reach the
 * model, tool-definition characters, wall-clock time of the tool/sandbox
 * part, correctness against ground truth, behaviour when one call fails.
 * DERIVED (scripted, not a live model): number of model turns and an
 * approximate cumulative-context size. NOT_VERIFIED: real tokens, model
 * latency, whether a model writes this code correctly on its own.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCodeModeMcpServer } from "../src/mcp.ts";
import type { Isolation } from "../src/index.ts";
import { ordersServer, ORDERS, CUSTOMERS, type Counters } from "../tests/fixtures/servers.ts";

type R = { content: Array<{ text: string }>; isError?: boolean };
async function connect(s: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(b);
  const c = new Client({ name: "bench", version: "1" });
  await c.connect(a);
  return c;
}
const textOf = (r: unknown) => (r as R).content.map((c) => c.text).join("\n");

const gold = new Set(CUSTOMERS.filter((c) => c.tier === "gold").map((c) => c.id));
const truth = ORDERS.filter((o) => o.status === "pending" && gold.has(o.customerId)).map((o) => ({ id: o.id, total: o.total }));
const truthSum = truth.reduce((a, o) => a + o.total, 0);

async function baseline(failCustomer?: string) {
  const counters: Counters = { calls: {}, writes: [] };
  const client = await connect(ordersServer(counters, { failCustomer }).server);
  const defsChars = JSON.stringify((await client.listTools()).tools).length;
  const t0 = performance.now();
  const resultsToModel: number[] = [];
  let seqTurns = 0, parTurns = 0, errors = 0;
  // pages are dependent (cursor) → one turn each in both variants
  const orders: Array<{ id: string; customerId: string; total: number; status: string }> = [];
  let cursor: string | null = null;
  do {
    const r = await client.callTool({ name: "list_orders", arguments: cursor ? { status: "pending", cursor } : { status: "pending" } });
    const txt = textOf(r);
    resultsToModel.push(txt.length);
    seqTurns++; parTurns++;
    const page = JSON.parse(txt);
    orders.push(...page.items);
    cursor = page.next;
  } while (cursor);
  // customer lookups are independent → 1 turn with parallel tool use, N turns sequentially
  const ids = [...new Set(orders.map((o) => o.customerId))];
  const tiers = new Map<string, string>();
  for (const id of ids) {
    const r = await client.callTool({ name: "get_customer", arguments: { id } });
    const txt = textOf(r);
    resultsToModel.push(txt.length);
    seqTurns++;
    if ((r as R).isError) { errors++; continue; }
    tiers.set(id, JSON.parse(txt).tier);
  }
  parTurns++;
  if (errors) { seqTurns++; parTurns++; } // model must notice and report/handle the failure
  seqTurns++; parTurns++; // final answer
  const picked = orders.filter((o) => tiers.get(o.customerId) === "gold").map((o) => ({ id: o.id, total: o.total }));
  const ms = performance.now() - t0;
  return { defsChars, toolCalls: Object.values(counters.calls).reduce((a, b) => a + b, 0), resultsToModel, seqTurns, parTurns, ms, picked, errors };
}

const CANDIDATE_CODE = `async () => {
  const all = await helpers.paginate((cursor) => codemode.list_orders(cursor == null ? { status: "pending" } : { status: "pending", cursor }));
  const ids = [...new Set(all.items.map((o) => o.customerId))];
  const res = await helpers.parallel(ids.map((id) => () => codemode.get_customer({ id })), { concurrency: 4 });
  const tier = {}; const failed = [];
  res.forEach((r, i) => r.ok ? (tier[ids[i]] = r.value.tier) : failed.push({ id: ids[i], error: r.error }));
  const orders = all.items.filter((o) => tier[o.customerId] === "gold").map((o) => ({ id: o.id, total: o.total }));
  return { orders, sum: orders.reduce((a, o) => a + o.total, 0), failedCustomers: failed, complete: failed.length === 0 };
}`;

async function candidate(failCustomer?: string, isolation: Isolation = "worker") {
  const counters: Counters = { calls: {}, writes: [] };
  const client = await connect(await createCodeModeMcpServer({ upstream: ordersServer(counters, { failCustomer }).server, policy: { read: ["list_orders", "get_customer"] }, isolation }));
  const defsChars = JSON.stringify((await client.listTools()).tools).length;
  const t0 = performance.now();
  const r = await client.callTool({ name: "code", arguments: { code: CANDIDATE_CODE } });
  const ms = performance.now() - t0;
  const txt = textOf(r);
  const out = JSON.parse(txt);
  return { defsChars, toolCalls: Object.values(counters.calls).reduce((a, b) => a + b, 0), resultsToModel: [txt.length], turns: 2, ms, out, codeChars: CANDIDATE_CODE.length };
}

/** Rough cumulative context: turn t re-reads tool defs + results returned before it (result t arrives for turn t+1). ESTIMATE; model output (tool-call JSON / code) not counted. */
function cumulative(defs: number, results: number[], turns: number) {
  let total = 0, acc = 0;
  for (let t = 0; t < turns; t++) { total += defs + acc; acc += results[t] ?? 0; }
  return total;
}

const runs = 20;
async function median<T extends { ms: number }>(f: () => Promise<T>) {
  const xs: T[] = [];
  for (let i = 0; i < runs; i++) xs.push(await f());
  xs.sort((a, b) => a.ms - b.ms);
  const q = (p: number) => xs[Math.round(p * (runs - 1))].ms;
  return { ...xs[Math.floor(runs / 2)], msP10: q(0.1), msP90: q(0.9) };
}

const b = await median(() => baseline());
const c = await median(() => candidate());
const ci = await median(() => candidate(undefined, "inline"));
const sumB = b.resultsToModel.reduce((a, x) => a + x, 0);
const correctB = JSON.stringify(b.picked) === JSON.stringify(truth);
const correctC = JSON.stringify(c.out.orders) === JSON.stringify(truth) && c.out.sum === truthSum && JSON.stringify(ci.out) === JSON.stringify(c.out);

const bf = await baseline("c-1");
const cf = await candidate("c-1");

const report = {
  workflow: "pending orders of gold-tier customers -> ids, totals, sum (synthetic data, in-memory MCP)",
  date: new Date().toISOString(),
  node: process.version,
  runs,
  measured: {
    toolInvocations: { baseline: b.toolCalls, candidate: c.toolCalls },
    toolOutputCharsReachingModel: { baseline: sumB, candidate: c.resultsToModel[0] },
    toolDefinitionChars: { baseline: b.defsChars, candidate: c.defsChars },
    candidateCodeChars_modelOutput: c.codeChars,
    toolWallClockMsMedian: {
      baseline: +b.ms.toFixed(2), candidateWorker: +c.ms.toFixed(2), candidateInline: +ci.ms.toFixed(2),
      p10p90: { baseline: [+b.msP10.toFixed(2), +b.msP90.toFixed(2)], candidateWorker: [+c.msP10.toFixed(2), +c.msP90.toFixed(2)], candidateInline: [+ci.msP10.toFixed(2), +ci.msP90.toFixed(2)] },
    },
    correct: { baseline: correctB, candidate: correctC },
    onFailure_customer_c1_unavailable: {
      baseline: { errorsReturnedToModel: bf.errors, extraTurnsToHandle: 1 },
      candidate: { complete: cf.out.complete, failedCustomers: cf.out.failedCustomers, partialOrdersReturned: cf.out.orders.length },
    },
  },
  derived_scripted: {
    modelTurns: { baselineSequential: b.seqTurns, baselineParallelToolUse: b.parTurns, candidate: c.turns },
    cumulativeContextCharsEstimate: {
      baselineSequential: cumulative(b.defsChars, b.resultsToModel, b.seqTurns),
      candidate: cumulative(c.defsChars, c.resultsToModel, c.turns) + c.codeChars,
    },
  },
  NOT_VERIFIED: ["real input/output tokens (no tokenizer or model in the loop; chars/4 is only a rough proxy)", "model latency", "whether a model writes the candidate code unaided", "behaviour over real network MCP servers"],
};
console.log(JSON.stringify(report, null, 2));
