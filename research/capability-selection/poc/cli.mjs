import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { createCapabilityClient } from './client.ts';
import { createSyntheticHost } from './synthetic-host.ts';

try {
  let args;
  try { args = parseArgs({ options: { config: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true, strict: true }); }
  catch { throw new Error('CLI_USAGE'); }
  const [command] = args.positionals;
  if (args.positionals.length !== 1 || !['capabilities', 'resolve', 'run'].includes(command) ||
      (command === 'capabilities' ? args.values.config !== undefined : !args.values.config)) throw new Error('CLI_USAGE');
  const client = createCapabilityClient(createSyntheticHost());
  let result;
  if (command === 'capabilities') result = client.capabilities();
  else {
    const file = await open(args.values.config, 'r');
    let raw;
    try {
      if ((await file.stat()).size > 65_536) throw new Error('INVALID_CONFIG');
      raw = await file.readFile('utf8');
    } finally { await file.close(); }
    result = command === 'resolve' ? client.resolve(raw) : await client.run(raw);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const code = ['CLI_USAGE', 'INVALID_CONFIG'].includes(error.message) ? error.message : 'CONFIG_READ_FAILED';
  console.log(JSON.stringify({ ok: false, error: { code, message: code }, audit: [] }));
  process.exitCode = 1;
}
