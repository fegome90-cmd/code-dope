const { createCapabilityClient } = await import('../../poc/client.ts');
const { createSyntheticHost } = await import('../../poc/synthetic-host.ts');
const scenario = process.argv[2];
const host = createSyntheticHost();
if (scenario === 'native') {
  const context = host.readContext();
  host.readContext = () => ({ ...context, availableRoutes: ['native'], allowedRoutes: ['native'] });
  host.native = { verification: 'NOT_VERIFIED', load: async () => ({ execute: async (_code, providers) => ({ result: await providers[0].fns.sum({ values: [5, -2, 10] }), logs: [] }) }) };
}
const client = createCapabilityClient(host);
const route = scenario === 'denied' ? 'pool' : scenario === 'unavailable' ? 'native' : ['worker', 'native'].includes(scenario) ? scenario : 'direct';
const config = JSON.stringify({ mode: 'auto', request: { schemaVersion: 1, route }, operation: route === 'direct'
  ? { kind: 'call', provider: 'math', tool: 'sum', args: { values: [5, -2, 10] } }
  : { kind: 'program', code: 'async () => await math.sum({values:[5,-2,10]})' } });
let result;
if (scenario === 'import') result = { imported: true };
else if (scenario === 'resolve') result = client.resolve(config);
else if (scenario === 'prepare') {
  const { createDefaultExecutor } = await import('../../../../src/executor/default.ts');
  createDefaultExecutor('worker');
  result = { prepared: true };
} else if (scenario === 'invalid') result = await client.run('{');
else result = await client.run(config);
console.log(JSON.stringify(result));
