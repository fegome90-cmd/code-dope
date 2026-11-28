// Run separately: these are the required acceptance tests, expected to fail on the original baseline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callDirect} from '../fixtures/baseline/direct.ts';
for(const [name,validator] of [['false',()=>false],['empty-string',()=> ''],['null',()=>null],['number-zero',()=>0],['malformed-safeParse',{safeParse:()=>({success:'yes'})}]]){
  test(`policy fail-closed: ${name}`,async()=>{
    let invoked=0;
    const r=await callDirect({provider:'crm',tool:'read',args:{}},[{name:'crm',fns:{read:async()=>++invoked}}],{read:['read'],validate:{read:validator}});
    assert.equal(invoked,0,'invalid arguments must not reach the tool');assert.match(r.error,/invalid arguments/);
  });
}
