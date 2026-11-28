// NOT RUN in the delivery environment. Requires a verified published tarball, Node >=24,
// @opencode/codemode from the pinned source revision, and its compatible Effect version.
// These are compatibility probes, not a production Executor adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeMode, Tool } from '@opencode/codemode';
import { Effect, Schema } from 'effect';
const limits = {timeoutMs:1000,maxToolCalls:8,maxOutputBytes:16384};
const run = (runtime, code) => Effect.runPromise(runtime.execute(code));
const echo = value => Tool.make({description:'Synthetic read',input:Schema.Struct({}),output:Schema.String,execute:()=>Effect.succeed(value)});
test('catalog property and explicit tool execution',async()=>{
  const rt=CodeMode.make({tools:{fixture:{read:echo('ok')}},limits});
  assert.ok(Array.isArray(rt.catalog));assert.equal(rt.catalog[0].path,'fixture.read');
  const r=await run(rt,'return await tools.fixture.read({})');assert.equal(r.ok,true);assert.equal(r.value,'ok');
});
test('canonical dotted path collision is last-wins upstream, not acceptable as Code Dope mapping',async()=>{
  const rt=CodeMode.make({tools:{'a.b':echo('first'),a:{b:echo('second')}},limits});
  assert.equal(rt.catalog.length,1);assert.equal((await run(rt,'return await tools.a.b({})')).value,'second');
});
test('Effect Schema rejects malformed arguments; JSON Schema must not be used as an enforcement substitute',async()=>{
  let effectCalls=0,jsonCalls=0;
  const typed=Tool.make({description:'typed',input:Schema.Struct({id:Schema.String}),output:Schema.Unknown,execute:x=>{effectCalls++;return Effect.succeed(x);}});
  const described=Tool.make({description:'described',input:{type:'object',properties:{id:{type:'string'}},required:['id']},output:Schema.Unknown,execute:x=>{jsonCalls++;return Effect.succeed(x);}});
  const rt=CodeMode.make({tools:{typed,described},limits});
  assert.equal((await run(rt,'return await tools.typed({id:1})')).ok,false);assert.equal(effectCalls,0);
  assert.equal((await run(rt,'return await tools.described({id:1})')).ok,true);assert.equal(jsonCalls,1);
});
test('before hook denies calls before host execution',async()=>{
  let calls=0;const t=Tool.make({description:'write fixture',input:Schema.Struct({}),output:Schema.Unknown,execute:()=>{calls++;return Effect.succeed({ok:true});}});
  const rt=CodeMode.make({tools:{write:t},limits,hooks:{'tool.before':()=>Effect.fail(new Error('denied fixture'))}});
  assert.equal((await run(rt,'return await tools.write({})')).ok,false);assert.equal(calls,0);
});
test('no implicit host filesystem or process access',async()=>{
  const rt=CodeMode.make({tools:{},limits});
  const r=await run(rt,'return [typeof process, typeof require, typeof fetch]');assert.equal(r.ok,true);assert.deepEqual(r.value,['undefined','undefined','undefined']);
});
