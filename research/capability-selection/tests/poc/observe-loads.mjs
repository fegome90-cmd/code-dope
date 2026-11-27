// Test-only preload; copied into mkdtemp so worker inheritance needs no environment variables.
import { registerHooks, createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

const trace = new URL('./trace.jsonl', import.meta.url);
const record = (kind, details = {}) => appendFileSync(trace, JSON.stringify({ threadId, kind, ...details }) + '\n');
record('observer-start');
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (/\/src\/executor\/|\/src\/helpers\.ts$|quickjs|\.wasm/.test(url)) {
    const module = url.includes('/node_modules/') ? url.split('/node_modules/').at(-1) : url.slice(url.indexOf('/src/') + 1);
    record('module-load', { module });
  }
  return loaded;
} });
for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
  const original = WebAssembly[name];
  if (typeof original === 'function') WebAssembly[name] = function (...args) {
    // Node's TypeScript stripper has its own WASM. Count QuickJS separately.
    record('wasm-api', { name, quickjs: /@jitl|quickjs-emscripten/.test(new Error().stack) });
    return Reflect.apply(original, this, args);
  };
}
for (const name of ['Module', 'Instance']) {
  WebAssembly[name] = new Proxy(WebAssembly[name], { construct(target, args, newTarget) {
    record('wasm-constructor', { name, quickjs: /@jitl|quickjs-emscripten/.test(new Error().stack) });
    return Reflect.construct(target, args, newTarget);
  } });
}
const wt = createRequire(import.meta.url)('node:worker_threads');
const OriginalWorker = wt.Worker;
wt.Worker = class ObservedWorker extends OriginalWorker {
  constructor(...args) {
    record('worker-create');
    super(...args);
    this.once('exit', code => record('worker-exit', { code }));
  }
};
syncBuiltinESMExports();
