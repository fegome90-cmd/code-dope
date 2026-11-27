import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../poc/cli.mjs', import.meta.url));
const invoke = args => {
  const p = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { exit: p.status, value: JSON.parse(p.stdout), stderr: p.stderr };
};
test('CLI capabilities and resolve expose authorized choices without running a tool', () => {
  const c = invoke(['capabilities', '--json']); assert.equal(c.exit, 0);
  assert.deepEqual(c.value.effective.routes, ['direct', 'worker']);
  assert.deepEqual(c.value.tools.find(t => t.provider === 'math' && t.tool === 'sum').inputSchema.required, ['values']);
  const r = invoke(['resolve', '--config', fileURLToPath(new URL('../../examples/off.json', import.meta.url))]);
  assert.equal(r.exit, 0); assert.equal(r.value.plan.route, 'direct'); assert.equal(r.value.plan.requestedMode, 'off');
});
test('CLI direct and real worker share the host synthetic catalog', () => {
  for (const example of ['off', 'on']) {
    const r = invoke(['run', '--config', fileURLToPath(new URL(`../../examples/${example}.json`, import.meta.url))]);
    assert.equal(r.exit, 0); assert.equal(r.value.result, 13); assert.equal(r.value.audit[0].outcome, 'done');
  }
});
test('CLI rejects generic execution flags and invalid config with structured nonzero errors', () => {
  for (const args of [['run', '--command', 'echo unsafe'], ['run'], ['install'], ['capabilities', '--config', 'file']]) {
    const r = invoke(args); assert.equal(r.exit, 1); assert.equal(r.value.ok, false); assert.equal(r.value.error.code, 'CLI_USAGE');
  }
  const dir = mkdtempSync(join(tmpdir(), 'selection-cli-'));
  try {
    const path = join(dir, 'invalid.json'); writeFileSync(path, '{"mode":"auto","request":{"route":"worker"},"operation":{}}');
    const r = invoke(['run', '--config', path]); assert.equal(r.exit, 1); assert.equal(r.value.error.code, 'INVALID_CONFIG');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
