import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityClient } from '../../poc/client.ts';

const call = { kind: 'call', provider: 'math', tool: 'sum', args: { values: [5, -2, 10] } };
const program = { kind: 'program', code: 'async () => await math.sum({values:[5,-2,10]})' };
const config = (route = 'direct', mode = 'auto', operation = route === 'direct' ? call : program, telemetry = 'minimal') =>
  JSON.stringify({ mode, request: { schemaVersion: 1, route, telemetry }, operation });
const fixture = (overrides = {}) => {
  const effects = [];
  let context = { mode: 'auto', availableRoutes: ['direct', 'worker', 'inline', 'pool'],
    allowedRoutes: ['direct', 'worker'], revision: 'host-1', policyVersion: 'policy-1',
    extendedAvailable: false, extendedAllowed: false };
  const providers = [{ name: 'math', fns: {
    sum: async ({ values }) => { effects.push(['sum', values]); return values.reduce((a, b) => a + b, 0); },
    write: async (args) => { effects.push(['write', args]); return { saved: true }; },
    'get-user': async () => 'exact', get_user: async () => 'alias',
  } }];
  const policy = { read: ['math.sum', 'math.get-user'], write: ['math.write'],
    validate: { 'math.sum': a => Array.isArray(a?.values) && a.values.every(Number.isFinite) ? true : 'values must be finite numbers' } };
  const host = { readContext: () => context, providers, policy, ...overrides };
  const client = createCapabilityClient(host);
  return { client, effects, host, setContext: x => { context = { ...context, ...x }; } };
};

test('P01 OFF uses current policy, returns exact sum, and retains mandatory audit', async () => {
  const f = fixture(); const r = await f.client.run(config('direct', 'off'));
  assert.equal(r.ok, true); assert.equal(r.result, 13);
  assert.deepEqual(f.effects, [['sum', [5, -2, 10]]]);
  assert.equal(r.audit[0].outcome, 'done'); assert.equal(r.plan.route, 'direct');
});
test('P02 ON runs the same catalog through the real default worker', async () => {
  const f = fixture(); const r = await f.client.run(config('worker', 'on'));
  assert.equal(r.ok, true); assert.equal(r.result, 13);
  assert.deepEqual(f.effects, [['sum', [5, -2, 10]]]);
  assert.equal(r.audit[0].decision, 'allowed'); assert.equal(r.plan.route, 'worker');
});
test('P03 AUTO permits caller selection for a one-call and a composed program (resolver test, not agent evidence)', async () => {
  const f = fixture();
  assert.equal((await f.client.run(config('direct'))).result, 13);
  const r = await f.client.run(config('worker', 'auto', { kind: 'program', code: 'async () => {const a=await math.sum({values:[2,3]}); return (await math.sum({values:[a,7]}));}' }));
  assert.equal(r.result, 12); assert.equal(r.audit.length, 2);
});
test('P04 malformed config and attempted authority overrides are rejected before dispatch', async () => {
  const f = fixture();
  for (const raw of ['{', 'null', JSON.stringify({ ...JSON.parse(config()), policy: { read: ['*'] } }), config('worker', 'off'), config('direct', 'on'), config('worker', 'on', call)]) {
    const r = await f.client.run(raw); assert.equal(r.ok, false); assert.ok(r.error.code); assert.deepEqual(r.audit, []);
  }
  assert.deepEqual(f.effects, []);
  assert.equal((await f.client.run(config())).result, 13);
});
test('P05 missing native host reports unavailable and never silently runs locally', async () => {
  const f = fixture(); const r = await f.client.run(config('native', 'on'));
  assert.equal(r.error.code, 'UNAVAILABLE'); assert.deepEqual(f.effects, []);
});
test('P06 installed pool remains denied; requested AUTO cannot expand mandatory OFF', async () => {
  const f = fixture(); assert.equal((await f.client.run(config('pool', 'on'))).error.code, 'DENIED');
  f.setContext({ mode: 'off' }); assert.equal((await f.client.run(config('worker', 'auto'))).error.code, 'MODE_CONFLICT');
  assert.equal((await f.client.run(config('direct', 'auto'))).result, 13);
});
for (const route of ['direct', 'worker']) test(`P07 ${route}: write without approval causes zero host writes`, async () => {
  const f = fixture(); const op = route === 'direct' ? { kind: 'call', provider: 'math', tool: 'write', args: { value: 1 } } : { kind: 'program', code: 'async () => await math.write({value:1})' };
  const r = await f.client.run(config(route, 'auto', op));
  assert.equal(r.ok, false); assert.match(r.error.message, /no approval/); assert.equal(r.audit[0].decision, 'denied'); assert.deepEqual(f.effects, []);
});
test('P09 identical request and versions reproduce the same plan', () => {
  const f = fixture(); const a = f.client.resolve(config('worker', 'on'));
  assert.equal(a.ok, true); assert.equal(a.plan.route, 'worker');
  for (let i = 0; i < 20; i++) assert.deepEqual(f.client.resolve(config('worker', 'on')), a);
});
test('P12 minimal telemetry still delivers host and local audit; extended cannot be smuggled', async () => {
  const records = []; const f = fixture(); f.host.policy.audit = r => records.push(r);
  const r = await f.client.run(config()); assert.equal(r.result, 13); assert.equal(r.audit.length, 1); assert.equal(records.length, 1);
  assert.equal((await f.client.run(config('direct', 'auto', call, 'extended'))).error.code, 'UNAVAILABLE_TELEMETRY');
});
for (const route of ['direct', 'worker']) test(`P13 ${route}: policy keeps exact collision names and validation`, async () => {
  const f = fixture();
  const op = tool => route === 'direct' ? { kind: 'call', provider: 'math', tool, args: {} } : { kind: 'program', code: `async () => await math[${JSON.stringify(tool)}]({})` };
  const denied = await f.client.run(config(route, 'auto', op('get_user')));
  assert.equal(denied.ok, false); assert.match(denied.error.message, /collides/);
  assert.equal((await f.client.run(config(route, 'auto', op('get-user')))).result, 'exact');
  const invalid = route === 'direct' ? { ...call, args: { values: ['bad'] } } : { kind: 'program', code: 'async () => await math.sum({values:["bad"]})' };
  const r = await f.client.run(config(route, 'auto', invalid)); assert.match(r.error.message, /invalid arguments/); assert.deepEqual(f.effects, []);
});
test('capability view separates availability, grants and effective routes; providers are host-owned', () => {
  const f = fixture(); const r = f.client.capabilities();
  assert.equal(r.ok, true); assert.deepEqual(r.effective.routes, ['direct', 'worker']);
  assert.ok(r.availableRoutes.includes('pool')); assert.ok(!r.allowedRoutes.includes('pool'));
  assert.equal(r.nativeVerification, 'NOT_VERIFIED');
});
test('P10 revocation while a native adapter loads prevents host dispatch', async () => {
  let release; let entered;
  const loading = new Promise(r => { entered = r; });
  const pending = new Promise(r => { release = r; });
  const f = fixture({ native: { verification: 'NOT_VERIFIED', load: async () => {
    entered(); await pending;
    return { execute: async (_code, guarded) => ({ result: await guarded[0].fns.sum({ values: [2, 3] }), logs: [] }) };
  } } });
  f.setContext({ availableRoutes: ['direct', 'native'], allowedRoutes: ['direct', 'native'] });
  const run = f.client.run(config('native', 'on'));
  await loading; f.setContext({ revision: 'host-2', allowedRoutes: ['direct'] }); release();
  const result = await run; assert.equal(result.error.code, 'DENIED'); assert.deepEqual(f.effects, []);
  assert.equal((await f.client.run(config('direct'))).result, 13);
});
test('native adapter contract uses current guarded providers and reports NOT_VERIFIED host evidence', async () => {
  const f = fixture({ native: { verification: 'NOT_VERIFIED', load: async () => ({
    execute: async (_code, guarded) => ({ result: await guarded[0].fns.sum({ values: [9, -4] }), logs: [] })
  }) } });
  f.setContext({ availableRoutes: ['native'], allowedRoutes: ['native'] });
  const r = await f.client.run(config('native', 'on')); assert.equal(r.result, 5); assert.equal(r.audit[0].outcome, 'done');
  assert.equal(r.nativeVerification, 'NOT_VERIFIED');
});
test('native thrown failure after a completed tool preserves mandatory audit and never retries', async () => {
  const f = fixture({ native: { verification: 'NOT_VERIFIED', load: async () => ({
    execute: async (_code, guarded) => { await guarded[0].fns.write({ id: 'one' }); throw new Error('native delivery failed'); }
  }) } });
  f.host.policy.approve = () => true;
  f.setContext({ availableRoutes: ['native'], allowedRoutes: ['native'] });
  const r = await f.client.run(config('native', 'on'));
  assert.equal(r.ok, false); assert.equal(r.audit[0]?.outcome, 'done'); assert.match(r.error.message, /native delivery failed/);
  assert.deepEqual(f.effects, [['write', { id: 'one' }]]);
});
for (const route of ['direct', 'worker']) test(`P11 ${route}: timeout retains unknown write outcome without automatic retry`, async () => {
  let writes = 0; let finish;
  const pending = new Promise(r => { finish = r; });
  const f = fixture(); f.host.policy.approve = () => true; f.host.policy.callTimeoutMs = 10;
  f.host.providers[0].fns.write = async () => { writes++; return pending; };
  const operation = route === 'direct' ? { kind: 'call', provider: 'math', tool: 'write', args: {} } : { kind: 'program', code: 'async () => await math.write({})' };
  const r = await f.client.run(config(route, 'auto', operation));
  assert.equal(r.ok, false); assert.equal(r.audit[0].outcome, 'unknown'); assert.equal(writes, 1);
  finish({ saved: true }); await Promise.resolve(); assert.equal(writes, 1);
});
test('current plan metadata follows the context actually used for dispatch', async () => {
  const f = fixture(); let reads = 0;
  const original = f.host.readContext;
  f.host.readContext = () => ({ ...original(), revision: ++reads === 1 ? 'first' : 'current' });
  const r = await f.client.run(config());
  // A revision change during resolution/loading must never yield a stale successful receipt.
  assert.ok(!r.ok || r.plan.revision === 'current');
});
test('budget is still per execution and guarded across programmatic calls', async () => {
  const f = fixture(); f.host.policy.maxCalls = 1;
  const r = await f.client.run(config('worker', 'on', { kind: 'program', code: 'async () => {await math.sum({values:[1]});return await math.sum({values:[2]});}' }));
  assert.equal(r.ok, false); assert.match(r.error.message, /budget/); assert.deepEqual(f.effects, [['sum', [1]]]);
  assert.equal(r.audit[1].decision, 'denied');
});
test('approved write retains its snapshot, independent from approval mutations', async () => {
  const f = fixture(); f.host.policy.approve = async req => { req.args.id = 'changed'; return true; };
  const r = await f.client.run(config('direct', 'off', { kind: 'call', provider: 'math', tool: 'write', args: { id: 'original' } }));
  assert.equal(r.ok, true); assert.deepEqual(f.effects, [['write', { id: 'original' }]]);
});
test('pool cleanup failure preserves completed-call audit and does not replay', async () => {
  const { PooledWorkerExecutor } = await import('../../../../src/executor/pool-executor.ts');
  const close = PooledWorkerExecutor.prototype.close;
  PooledWorkerExecutor.prototype.close = async function () { await close.call(this); throw new Error('cleanup failed'); };
  try {
    const f = fixture({ executorOptions: { size: 1, prewarm: false } });
    f.setContext({ allowedRoutes: ['pool'] });
    const r = await f.client.run(config('pool', 'on'));
    assert.equal(r.audit[0]?.outcome, 'done'); assert.equal(r.result, 13);
    assert.equal(r.ok, false); assert.match(r.error.message, /cleanup failed/);
    assert.deepEqual(f.effects, [['sum', [5, -2, 10]]]);
  } finally { PooledWorkerExecutor.prototype.close = close; }
});
test('empty tool error is still a failed execution with its audit preserved', async () => {
  const f = fixture(); f.host.providers[0].fns.sum = async () => { throw new Error(''); };
  const r = await f.client.run(config());
  assert.equal(r.ok, false); assert.equal(r.error.code, 'EXECUTION_FAILED');
  assert.equal(r.audit[0].outcome, 'failed');
});
test('optional extended audit sink failures preserve results and mandatory local records', async () => {
  const mandatory = []; const extended = []; const f = fixture();
  f.setContext({ extendedAvailable: true, extendedAllowed: true });
  f.host.policy.audit = record => { mandatory.push(record); throw new Error('host sink unavailable'); };
  f.host.extendedAudit = async record => { extended.push(record); throw new Error('extended sink unavailable'); };
  for (const telemetry of ['minimal', 'extended']) {
    const r = await f.client.run(config('direct', 'off', call, telemetry));
    assert.equal(r.result, 13); assert.equal(r.ok, true); assert.equal(r.audit[0].outcome, 'done');
  }
  assert.equal(mandatory.length, 2); assert.equal(extended.length, 1);
  assert.deepEqual(f.effects, [['sum', [5, -2, 10]], ['sum', [5, -2, 10]]]);
});
test('native revocation after a write starts preserves outcome, audit and invoked-adapter metadata', async () => {
  for (const replacement of [undefined, { verification: 'VERIFIED', load: async () => { throw new Error('replacement must not load'); } }]) {
    let started; let finish;
    const entered = new Promise(r => { started = r; });
    const pending = new Promise(r => { finish = r; });
    const f = fixture({ native: { verification: 'NOT_VERIFIED', load: async () => ({
      execute: async (_code, guarded) => ({ result: await guarded[0].fns.write({ id: 'in-flight' }), logs: [] })
    }) } });
    f.host.policy.approve = () => true;
    let writes = 0;
    f.host.providers[0].fns.write = async () => { writes++; started(); await pending; return { saved: true }; };
    f.setContext({ availableRoutes: ['native'], allowedRoutes: ['native'] });
    const execution = f.client.run(config('native', 'on'));
    await entered;
    f.setContext({ availableRoutes: [], allowedRoutes: [], revision: 'revoked-after-dispatch' });
    f.host.native = replacement;
    finish();
    const r = await execution;
    assert.equal(writes, 1); assert.equal(r.ok, true); assert.deepEqual(r.result, { saved: true });
    assert.equal(r.audit[0].outcome, 'done'); assert.equal(r.nativeVerification, 'NOT_VERIFIED');
    assert.equal(r.plan.revision, 'host-1');
  }
});
