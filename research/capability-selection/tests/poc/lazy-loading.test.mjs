import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function observe(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'selection-loads-'));
  try {
    const observer = join(dir, 'observe.mjs'); copyFileSync(new URL('./observe-loads.mjs', import.meta.url), observer);
    const p = spawnSync(process.execPath, ['--import', observer, fileURLToPath(new URL('./observe-scenario.mjs', import.meta.url)), scenario], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const events = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { value: JSON.parse(p.stdout), events,
      modules: events.filter(e => e.kind === 'module-load'),
      workers: events.filter(e => e.kind === 'worker-create'),
      quickjs: events.filter(e => e.quickjs),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('P08 OFF/native-contract/import/resolve/rejection load no local runtime; worker is the real positive control', () => {
  const values = {};
  for (const scenario of ['import', 'resolve', 'direct', 'native', 'invalid', 'denied', 'unavailable']) {
    const r = observe(scenario); values[scenario] = r.value;
    assert.equal(r.modules.length, 0, scenario + ': local modules');
    assert.equal(r.workers.length, 0, scenario + ': workers');
    assert.equal(r.quickjs.length, 0, scenario + ': QuickJS initialization');
  }
  assert.equal(values.import.imported, true); assert.equal(values.resolve.plan.route, 'direct');
  assert.equal(values.direct.result, 13); assert.equal(values.direct.audit[0].outcome, 'done');
  assert.equal(values.native.result, 13); assert.equal(values.native.nativeVerification, 'NOT_VERIFIED');
  assert.equal(values.invalid.error.code, 'INVALID_CONFIG'); assert.equal(values.denied.error.code, 'DENIED'); assert.equal(values.unavailable.error.code, 'UNAVAILABLE');
  const worker = observe('worker');
  assert.equal(worker.value.result, 13); assert.equal(worker.value.audit[0].outcome, 'done');
  assert.ok(worker.modules.some(m => m.module === 'src/executor/pool-executor.ts'), 'existing factory imports all executor classes');
  assert.equal(worker.workers.length, 1);
  assert.ok(worker.quickjs.some(e => e.threadId > 0 && e.kind === 'wasm-api' && e.name === 'instantiate'));
  assert.equal(worker.quickjs.filter(e => e.threadId === 0).length, 0);
});
test('P08 existing local factory can load classes and prepare worker executor without runtime initialization', () => {
  const r = observe('prepare'); assert.equal(r.value.prepared, true);
  assert.ok(r.modules.some(m => m.module === 'src/executor/quickjs-executor.ts'));
  assert.equal(r.workers.length, 0); assert.equal(r.quickjs.length, 0);
});
