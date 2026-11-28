import { Validator, type Schema } from '@cfworker/json-schema';
import type { CapabilityHost } from './client.ts';

const sumSchema: Schema = { type: 'object', additionalProperties: false, required: ['values'], properties: {
  values: { type: 'array', maxItems: 100, items: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 } },
} };
const saveSchema: Schema = { type: 'object', additionalProperties: false, required: ['note'], properties: {
  note: { type: 'string', maxLength: 200 },
} };

/** Fixed, in-memory tools. Nothing in agent config can register tools or approve a write. */
export function createSyntheticHost(): CapabilityHost {
  const notes: string[] = [];
  const sumValidator = new Validator(sumSchema, '7');
  const saveValidator = new Validator(saveSchema, '7');
  return {
    readContext: () => ({ mode: 'auto', availableRoutes: ['direct', 'worker', 'inline', 'pool'],
      allowedRoutes: ['direct', 'worker'], revision: 'synthetic-host-v1', policyVersion: 'synthetic-policy-v1',
      extendedAvailable: false, extendedAllowed: false }),
    providers: [
      { name: 'math', fns: { sum: async args => (args as { values: number[] }).values.reduce((a, b) => a + b, 0) } },
      { name: 'store', fns: { save: async args => { notes.push((args as { note: string }).note); return { saved: notes.length }; } } },
    ],
    policy: {
      read: ['math.sum'], write: ['store.save'], maxCalls: 20, callTimeoutMs: 500,
      validate: {
        'math.sum': args => sumValidator.validate(args).valid ? true : 'values must contain at most 100 bounded numbers',
        'store.save': args => saveValidator.validate(args).valid ? true : 'note must be a string of at most 200 characters',
      },
    },
    catalog: [
      { provider: 'math', tool: 'sum', description: 'Return the sum of values; empty input returns zero.', inputSchema: sumSchema },
      { provider: 'store', tool: 'save', description: 'Append a synthetic note in memory. Requires host approval, absent in this CLI.', inputSchema: saveSchema },
    ],
    executorOptions: { timeoutMs: 2_000, killGraceMs: 500 },
  };
}
