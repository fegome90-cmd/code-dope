/**
 * Sustained mixed-load pool benchmark. Report-only; do not add to test:all.
 * Run from bench/soak.ts with Node's TypeScript support. Stdout is one JSON object;
 * redirect it to a scratch file before publishing a completed bench/SOAK.json.
 */
import { release } from "node:os";
import { performance } from "node:perf_hooks";
import { PooledWorkerExecutor } from "../src/index.ts";

const DEFAULT_RUNS = 5_000;
const WINDOW_RUNS = 500;
const POOL_SIZE = 2;
const TIMEOUT_MS = 75;
const KILL_GRACE_MS = 1_000;
const MAX_ERROR_SAMPLES = 20;
const THROW_MESSAGE = "SOAK_EXPECTED_THROW";
const CODES = {
  ok: "async () => 42",
  throw: `async () => { throw new Error(${JSON.stringify(THROW_MESSAGE)}); }`,
  timeout: "async () => { while (true) {} }",
} as const;

type Kind = keyof typeof CODES;
type Counts = Record<Kind | "unexpected", number>;
type Memory = { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
type UnexpectedError = { execution: number; expected: Kind; phase: "result" | "rejection"; message: string };
type WindowSample = {
  window: number;
  firstExecution: number;
  lastExecution: number;
  executions: number;
  expectedCounts: Record<Kind, number>;
  outcomes: Counts;
  elapsedMs: number;
  latencyMs: { p50: number; p95: number; max: number };
  memory: Memory;
  spawned: number;
  spawnedSincePreviousWindow: number;
};

const newCounts = (): Counts => ({ ok: 0, throw: 0, timeout: 0, unexpected: 0 });
const roundMs = (value: number) => Math.round(value * 1_000) / 1_000;
const memory = (): Memory => {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  return { rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal };
};

function parseRuns(): number {
  const args = process.argv.slice(2);
  let supplied: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (supplied !== undefined) throw new Error("Specify --runs only once; no other arguments are supported");
    if (arg === "--runs") {
      supplied = args[++i];
      if (supplied === undefined) throw new Error("--runs requires an integer");
    } else if (arg.startsWith("--runs=")) {
      supplied = arg.slice("--runs=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const raw = supplied ?? process.env.SOAK_RUNS ?? String(DEFAULT_RUNS);
  if (!/^\d+$/.test(raw)) throw new Error("Runs must be a positive integer");
  const runs = Number(raw);
  if (!Number.isSafeInteger(runs) || !(runs === 50 || (runs >= WINDOW_RUNS && runs % WINDOW_RUNS === 0))) {
    throw new Error("Use 50 runs for smoke, or a positive multiple of 500 for the full benchmark");
  }
  return runs;
}

function kindAt(index: number): Kind {
  const position = index % 20;
  return position === 9 ? "throw" : position === 19 ? "timeout" : "ok";
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, 2_000);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

function matchesExpected(kind: Kind, result: Awaited<ReturnType<PooledWorkerExecutor["execute"]>>): boolean {
  if (kind === "ok") return !result.error && result.result === 42;
  if (!result.error) return false;
  if (kind === "throw") return result.error.includes(THROW_MESSAGE);
  return /\b(?:timed\s+out|timeout|interrupted)\b/i.test(result.error);
}

function trends(windows: WindowSample[]) {
  const first = windows[0];
  const last = windows.at(-1);
  const evaluated = windows.length > 1 && first !== undefined && last !== undefined;
  const rssRatio = evaluated ? last.memory.rssBytes / first.memory.rssBytes : null;
  const p95Ratio = evaluated && first.latencyMs.p95 > 0 ? last.latencyMs.p95 / first.latencyMs.p95 : null;
  const alerts: Array<{ metric: string; finalOverInitial: number; threshold: number }> = [];
  if (rssRatio !== null && rssRatio > 1.5) alerts.push({ metric: "rssBytes", finalOverInitial: rssRatio, threshold: 1.5 });
  if (p95Ratio !== null && p95Ratio > 2) alerts.push({ metric: "latencyP95Ms", finalOverInitial: p95Ratio, threshold: 2 });
  return {
    evaluated,
    baseline: "first completed window",
    final: "last completed window",
    reason: evaluated ? null : "At least two completed windows are required; smoke does not assess a trend",
    finalOverInitial: { rss: rssRatio, latencyP95: p95Ratio },
    thresholds: { rss: 1.5, latencyP95: 2 },
    alerts,
  };
}

async function runConfiguration(maxUses: number, runs: number) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  process.stderr.write(`[soak] maxUses=${maxUses} starting=${runs}\n`);
  const outcomes = newCounts();
  const expectedCounts = { ok: 0, throw: 0, timeout: 0 };
  const unexpectedErrors: UnexpectedError[] = [];
  const fatalErrors: Array<{ phase: string; message: string }> = [];
  const windows: WindowSample[] = [];
  const memoryBeforeWorkload = memory();
  let pool: PooledWorkerExecutor | undefined;
  let closed = false;
  let completed = 0;

  try {
    pool = new PooledWorkerExecutor({
      size: POOL_SIZE,
      maxUses,
      timeoutMs: TIMEOUT_MS,
      killGraceMs: KILL_GRACE_MS,
      idleMs: 0,
      prewarm: true,
    });
    const executor = pool;
    let previousSpawned = 0;

    for (let start = 0; start < runs; start += WINDOW_RUNS) {
      const end = Math.min(start + WINDOW_RUNS, runs);
      const windowStarted = performance.now();
      const latencies: number[] = [];
      const windowOutcomes = newCounts();
      const windowExpected = { ok: 0, throw: 0, timeout: 0 };
      let nextIndex = start;

      async function lane() {
        for (;;) {
          const index = nextIndex++;
          if (index >= end) return;
          const kind = kindAt(index);
          expectedCounts[kind]++;
          windowExpected[kind]++;
          const began = performance.now();
          let outcome: Kind | "unexpected" = kind;
          let unexpected: UnexpectedError | undefined;
          try {
            const result = await executor.execute(CODES[kind], {});
            if (!matchesExpected(kind, result)) {
              outcome = "unexpected";
              unexpected = {
                execution: index + 1,
                expected: kind,
                phase: "result",
                message: result.error ? `Returned error: ${result.error}`.slice(0, 2_000) : `Returned value: ${describe(result.result)}`,
              };
            }
          } catch (error) {
            outcome = "unexpected";
            unexpected = { execution: index + 1, expected: kind, phase: "rejection", message: describe(error) };
          } finally {
            latencies.push(performance.now() - began);
          }
          outcomes[outcome]++;
          windowOutcomes[outcome]++;
          completed++;
          if (unexpected && unexpectedErrors.length < MAX_ERROR_SAMPLES) unexpectedErrors.push(unexpected);
        }
      }

      await Promise.all([lane(), lane()]);
      latencies.sort((a, b) => a - b);
      const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)];
      const spawned = executor.stats.spawned;
      const sample: WindowSample = {
        window: windows.length + 1,
        firstExecution: start + 1,
        lastExecution: end,
        executions: latencies.length,
        expectedCounts: windowExpected,
        outcomes: windowOutcomes,
        elapsedMs: roundMs(performance.now() - windowStarted),
        latencyMs: { p50: roundMs(percentile(0.5)), p95: roundMs(percentile(0.95)), max: roundMs(latencies.at(-1)!) },
        memory: memory(),
        spawned,
        spawnedSincePreviousWindow: spawned - previousSpawned,
      };
      windows.push(sample);
      previousSpawned = spawned;
      process.stderr.write(`[soak] maxUses=${maxUses} completed=${end}/${runs} p95Ms=${sample.latencyMs.p95} spawned=${spawned} unexpected=${outcomes.unexpected}\n`);
    }
  } catch (error) {
    fatalErrors.push({ phase: "benchmark", message: describe(error) });
  } finally {
    if (pool) {
      try {
        await pool.close();
        closed = true;
      } catch (error) {
        fatalErrors.push({ phase: "close", message: describe(error) });
      }
    }
  }

  return {
    maxUses,
    status: fatalErrors.length ? "incomplete" : outcomes.unexpected ? "completed_with_unexpected_outcomes" : "completed",
    startedAt,
    elapsedMs: roundMs(performance.now() - started),
    requestedExecutions: runs,
    completedExecutions: completed,
    expectedCounts,
    outcomes,
    unexpectedErrors: { count: outcomes.unexpected, samples: unexpectedErrors, omitted: outcomes.unexpected - unexpectedErrors.length },
    fatalErrors,
    poolClosed: closed,
    memoryBeforeWorkload,
    windows,
    trend: trends(windows),
  };
}

const metadata = {
  schemaVersion: 1,
  benchmark: "PooledWorkerExecutor sustained mixed load",
  reportOnly: true,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, release: release() },
  units: { memory: "bytes", latency: "milliseconds", elapsed: "milliseconds", spawned: "workers" },
};

try {
  const runs = parseRuns();
  const configurations = [];
  for (const maxUses of [100, 1_000]) configurations.push(await runConfiguration(maxUses, runs));
  const incomplete = configurations.some((configuration) => configuration.status === "incomplete");
  const report = {
    ...metadata,
    status: incomplete ? "incomplete" : configurations.some((configuration) => configuration.outcomes.unexpected > 0) ? "completed_with_unexpected_outcomes" : "completed",
    parameters: { runsPerConfiguration: runs, windowRuns: WINDOW_RUNS, size: POOL_SIZE, maxUses: [100, 1_000], timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS, idleMs: 0, prewarm: true },
    methodology: {
      workload: "Repeat 9 OK, one throw, 9 OK, one timeout by submission index; two concurrent indexed loops per window",
      targetMix: { ok: 0.9, throw: 0.05, timeout: 0.05 },
      smoke: runs === 50,
      smokeMix: "50 runs use the deterministic prefix: 45 OK, 3 throws, 2 timeouts",
      percentile: "nearest rank within each window, across all execution kinds",
      latency: "Wall time around execute(), including worker readiness and pool overhead; no extra warm-up executions",
      memory: "RSS covers the process including workers; heapUsed and heapTotal cover the calling parent thread",
      outcomes: "OK/throw/timeout count expected matching results; all other returned results and rejections count as unexpected",
      errorSamples: `The first ${MAX_ERROR_SAMPLES} unexpected outcomes per configuration are retained; total and omitted counts remain explicit`,
      configurationOrder: "Sequential in the same parent process; trends compare the first and last completed windows within each configuration",
      recycling: "Errors recycle workers, so this workload may not reach maxUses; it measures sustained mixed-load stability",
      alerts: "RSS > 1.5 times or p95 > 2 times the first completed window; alerts and unexpected outcomes do not set a failing exit code",
    },
    configurations,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (incomplete) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ...metadata, status: "failed", fatalErrors: [{ phase: "setup", message: describe(error) }] }, null, 2)}\n`);
  process.exitCode = 1;
}
