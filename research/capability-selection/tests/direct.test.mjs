import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callDirect} from '../fixtures/baseline/direct.ts';
import {executeRequested} from '../selection.mjs';
const fixture = () => {
  const calls=[];
  const providers=[{name:'crm',fns:{'get-user':async a=>{calls.push(['read',a]);return {id:a.id};},'get_user':async a=>{calls.push(['other',a]);return a;},update:async a=>{calls.push(['write',a]);return {updated:true};}}}];
  const policy={read:['crm.get-user'],write:['crm.update']};
  const run=(tool,args={id:'fixture'},extra={})=>callDirect({provider:'crm',tool,args},providers,{...policy,...extra});
  return {calls,providers,policy,run};
};
test('actual withPolicy permits classified direct read and records audit',async()=>{
  const f=fixture();const r=await f.run('get-user');assert.deepEqual(r.result,{id:'fixture'});assert.equal(r.audit[0].decision,'allowed');assert.equal(f.calls.length,1);
});
test('sanitized name collision remains denied even on direct route',async()=>{
  const f=fixture();const r=await f.run('get_user');assert.match(r.error,/collides/);assert.equal(f.calls.length,0);
});
test('deny overrides allow, and wildcard does not bypass ambiguous names',async()=>{
  const f=fixture();assert.match((await f.run('get-user',{}, {deny:['get_user']})).error,/deny list/);
  assert.match((await f.run('get-user',{}, {read:['*']})).error,/collides/);assert.equal(f.calls.length,0);
});
test('exact names containing a literal dot are preserved',async()=>{
  const calls=[];const r=await callDirect({provider:'crm',tool:'group.item',args:7},[{name:'crm',fns:{'group.item':async a=>{calls.push(a);return a;}}}],{read:['crm.group.item']});assert.equal(r.result,7);assert.deepEqual(calls,[7]);
});
test('unclassified writes need approval; rejected approval has no host effect',async()=>{
  const f=fixture();assert.match((await f.run('update')).error,/no approval/);assert.match((await f.run('update',{}, {approve:async()=>false})).error,/approval rejected/);assert.equal(f.calls.length,0);
});
test('approved write uses argument snapshot; scope aborts approval signal after completion',async()=>{
  const f=fixture();const args={id:'original'};let signal;
  const r=await f.run('update',args,{approve:async a=>{signal=a.signal;a.args.id='mutated';args.id='caller';return true;}});
  assert.deepEqual(r.result,{updated:true});assert.deepEqual(f.calls,[['write',{id:'original'}]]);assert.equal(signal.aborted,true);
});
test('validation string and throwing validator deny before tool',async()=>{
  const f=fixture();assert.match((await f.run('get-user',{}, {validate:{'crm.get-user':()=> 'bad input'}})).error,/bad input/);
  assert.match((await f.run('get-user',{}, {validate:{'crm.get-user':()=>{throw new Error('bad')}}})).error,/validator threw/);assert.equal(f.calls.length,0);
});
test('per-execution budget zero, unknown and inherited tool do not invoke',async()=>{
  const f=fixture();assert.match((await f.run('get-user',{}, {maxCalls:0})).error,/budget/);
  for(const t of ['missing','toString','__proto__']) assert.equal((await f.run(t)).error,'UNKNOWN_OR_AMBIGUOUS_TOOL');assert.equal(f.calls.length,0);
});
test('duplicate provider rejected rather than last-wins',async()=>{
  const f=fixture();const r=await callDirect({provider:'crm',tool:'update',args:{}},[...f.providers,...f.providers],{...f.policy,approve:()=>true});assert.equal(r.error,'UNKNOWN_OR_AMBIGUOUS_TOOL');assert.equal(f.calls.length,0);
});
test('external audit rejection cannot change tool result; local audit retained',async()=>{
  const f=fixture();const r=await f.run('get-user',{id:'x'},{audit:async()=>{throw new Error('sink failure')}});assert.equal(r.result.id,'x');assert.equal(r.audit.length,1);
});
test('timeout after write begins retains unknown and does not repeat the operation',async()=>{
  let calls=0,release;
  const pending=new Promise(r=>{release=r});
  const r=await callDirect({provider:'crm',tool:'update',args:{}},[{name:'crm',fns:{update:async()=>{calls++;return pending;}}}],{write:['update'],approve:()=>true,callTimeoutMs:5});
  assert.match(r.error,/timed out/);assert.equal(r.audit[0].outcome,'unknown');assert.equal(calls,1);release('completed later');
});
test('end-to-end raw config OFF -> real direct policy; no synthetic local loader',async()=>{
  const f=fixture();let loads=0;
  const context={mode:'off',revision:'r1',policyVersion:'p1',availableRoutes:['direct','worker'],allowedRoutes:['direct'],extendedAvailable:false,extendedAllowed:false};
  const r=await executeRequested('{"schemaVersion":1,"route":"direct"}',()=>context,{direct:async()=> input=>callDirect(input,f.providers,f.policy),worker:async()=>{loads++;}}, {provider:'crm',tool:'get-user',args:{id:'test'}});
  assert.equal(r.result.id,'test');assert.equal(r.audit[0].outcome,'done');assert.equal(loads,0);
});
test('host reuses existing audit hook to select extended sink without switching off mandatory records',async()=>{
  const f=fixture();const mandatory=[],extended=[];
  const context={mode:'auto',revision:'r1',policyVersion:'p1',availableRoutes:['direct'],allowedRoutes:['direct'],extendedAvailable:true,extendedAllowed:true};
  // Host-owned consumer example; no telemetry framework and no extra dependency.
  const loaders={direct:async()=> (input,plan)=>callDirect(input,f.providers,{...f.policy,audit:r=>{
    mandatory.push(r);if(plan.telemetry==='extended')extended.push(r);
  }})};
  for(const telemetry of ['minimal','extended']){
    const result=await executeRequested(JSON.stringify({schemaVersion:1,route:'direct',telemetry}),()=>context,loaders,{provider:'crm',tool:'get-user',args:{id:telemetry}});
    assert.equal(result.audit.length,1);assert.equal(result.result.id,telemetry);
  }
  assert.equal(mandatory.length,2);assert.equal(extended.length,1);
});
test('direct result is detached JSON data, not the original host object',async()=>{
  const value={nested:{id:'original'}};
  const result=await callDirect({provider:'fixture',tool:'read',args:{}},[{name:'fixture',fns:{read:async()=>value}}],{read:['read']});
  result.result.nested.id='changed';assert.equal(value.nested.id,'original');
});
test('serialization failure does not misstate the host call or retry its side effect',async()=>{
  let calls=0;const cyclic={};cyclic.self=cyclic;
  const r=await callDirect({provider:'fixture',tool:'write',args:{}},[{name:'fixture',fns:{write:async()=>{calls++;return cyclic;}}}],{write:['write'],approve:()=>true});
  assert.equal(r.result,undefined);assert.match(r.error,/circular/i);assert.equal(r.audit[0].outcome,'done');assert.equal(calls,1);
});
