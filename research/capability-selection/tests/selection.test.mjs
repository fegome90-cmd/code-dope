import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve, capabilities, parseRequest, executeRequested, ROUTES} from '../selection.mjs';
const text = (route, telemetry) => JSON.stringify({schemaVersion:1,route,telemetry});
const env = (mode='auto',overrides={}) => ({mode,availableRoutes:[...ROUTES],allowedRoutes:[...ROUTES],revision:'rev1',policyVersion:'p1',extendedAvailable:true,extendedAllowed:true,...overrides});
for (const mode of ['off','on','auto']) for (const route of ROUTES) {
  test(`mode matrix ${mode}/${route}`,()=>{
    const allowed=mode==='auto'||(mode==='off')===(route==='direct');
    if(allowed) assert.equal(resolve(text(route),env(mode)).route,route);
    else assert.throws(()=>resolve(text(route),env(mode)),/MODE_CONFLICT/);
    assert.equal(capabilities(env(mode)).routes.includes(route),allowed);
  });
}
for (const [name,raw] of Object.entries({
  'null':'null','array':'[]','empty':'{}','bad-json':'{','version':'{"schemaVersion":2,"route":"direct"}',
  'unknown-route':text('constructor'),'unknown-telemetry':text('direct','off'),
  'authority':'{"schemaVersion":1,"route":"worker","allowedRoutes":["worker"]}',
  'proto':'{"schemaVersion":1,"route":"direct","__proto__":{}}',
  'mode':'{"schemaVersion":1,"route":"direct","mode":"auto"}',
  'prelude':'{"schemaVersion":1,"route":"worker","prelude":"unexpected"}',
  'too-large':text('direct')+' '.repeat(1025)
})) test(`reject ${name}`,()=>assert.throws(()=>resolve(raw,env()),/INVALID_CONFIG/));
test('reject nonserialized objects without invoking getters',()=>{
  const obj={get route(){throw new Error('getter executed')}};
  assert.throws(()=>parseRequest(obj),/INVALID_CONFIG/);
});
test('mode and authority absent fail closed',()=>{
  for(const x of [null,env('bad'),env('auto',{allowedRoutes:undefined}),env('auto',{revision:''}),env('auto',{extendedAllowed:'yes'})]) assert.throws(()=>resolve(text('direct'),x),/INVALID_HOST_CONTEXT/);
});
test('route availability distinct from permission',()=>{
  assert.throws(()=>resolve(text('native'),env('auto',{availableRoutes:['direct']})),/UNAVAILABLE/);
  assert.throws(()=>resolve(text('pool'),env('auto',{allowedRoutes:['direct']})),/DENIED/);
  assert.deepEqual(capabilities(env('auto',{availableRoutes:['direct','worker'],allowedRoutes:['direct','pool']})).routes,['direct']);
});
test('minimal audit is the default; optional extended only when allowed and available',()=>{
  assert.equal(resolve(text('direct'),env()).telemetry,'minimal');
  assert.equal(resolve(text('direct','extended'),env()).telemetry,'extended');
  assert.throws(()=>resolve(text('direct','extended'),env('auto',{extendedAvailable:false})),/UNAVAILABLE_TELEMETRY/);
  assert.throws(()=>resolve(text('direct','extended'),env('auto',{extendedAllowed:false})),/DENIED_TELEMETRY/);
  assert.deepEqual(capabilities(env('auto',{extendedAllowed:false})).telemetry,['minimal']);
});
test('deterministic plan and immutable output; ordering of grants is immaterial',()=>{
  const a=resolve(text('worker'),env());
  for(let i=0;i<100;i++) assert.deepEqual(a,resolve(text('worker'),env('auto',{allowedRoutes:[...ROUTES].reverse()})));
  assert.ok(Object.isFrozen(a));
  assert.throws(()=>{a.route='pool'},TypeError);
});
test('direct and native do not even evaluate local module (synthetic loader)',async()=>{
  const loaders={direct:async()=>()=> 'direct',native:async()=>()=> 'native',worker:async()=> (await import('./heavy.mjs')).invoke};
  assert.equal(await executeRequested(text('direct'),()=>env('off'),loaders,{}),'direct');
  assert.equal(await executeRequested(text('native'),()=>env('on'),loaders,{}),'native');
  assert.equal(globalThis.fixtureImports,undefined);
  assert.equal(await executeRequested(text('worker'),()=>env('on'),loaders,{}),'synthetic worker');
  assert.equal(globalThis.fixtureImports,1);
});
test('revocation during loading prevents dispatch',async()=>{
  let e=env(),invocations=0;
  await assert.rejects(executeRequested(text('worker'),()=>e,{worker:async()=>{e=env('auto',{allowedRoutes:['direct'],revision:'rev2'});return ()=>invocations++;}},null),/DENIED/);
  assert.equal(invocations,0);
});
test('changed revision prevents stale plan even if route still allowed',async()=>{
  let e=env(),invocations=0;
  await assert.rejects(executeRequested(text('worker'),()=>e,{worker:async()=>{e=env('auto',{revision:'rev2'});return ()=>invocations++;}},null),/STALE_CONTEXT/);
  assert.equal(invocations,0);
});
test('denied request never calls a loader',async()=>{
  let loads=0;
  await assert.rejects(executeRequested(text('pool'),()=>env('auto',{allowedRoutes:['direct']}),{pool:async()=>{loads++;}},null),/DENIED/);
  assert.equal(loads,0);
});
test('no inherited adapter and no automatic replay on failure',async()=>{
  await assert.rejects(executeRequested(text('worker'),()=>env(),Object.create({worker:async()=>()=>1}),null),/NO_ADAPTER/);
  let direct=0,worker=0;
  await assert.rejects(executeRequested(text('worker'),()=>env(),{worker:async()=>()=>{worker++;throw new Error('UNKNOWN_OUTCOME')},direct:async()=>()=>{direct++;}},null),/UNKNOWN_OUTCOME/);
  assert.equal(worker,1);assert.equal(direct,0);
});
test('parser semantics: duplicated JSON keys resolve via standard last-wins before strict validation',()=>{
  assert.equal(resolve('{"schemaVersion":1,"route":"worker","route":"direct"}',env('off')).route,'direct');
});
test('operation snapshot remains stable across loader await',async()=>{
  const input={args:{id:'first'}};
  const result=await executeRequested(text('worker'),()=>env(),{worker:async()=>{input.args.id='second';return x=>x.args.id;}},input);
  assert.equal(result,'first');assert.equal(input.args.id,'second');
});
test('UTF-8 request byte bound rejects multibyte input beyond 1024 bytes',()=>{
  // Padding with U+00A0 is not JSON whitespace, so put it inside an otherwise valid duplicated route key.
  const raw='{"schemaVersion":1,"route":"'+'é'.repeat(600)+'","route":"direct"}';
  assert.ok(raw.length<1024);assert.throws(()=>parseRequest(raw),/INVALID_CONFIG/);
});
