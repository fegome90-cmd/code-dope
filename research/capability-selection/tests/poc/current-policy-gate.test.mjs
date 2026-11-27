// Deliberately separate from the passing PoC suite: acceptance failures in the current core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDirect } from '../../poc/direct.ts';

for (const [name, validator] of [['false', () => false], ['empty-string', () => ''], ['null', () => null], ['number-zero', () => 0], ['malformed-safeParse', { safeParse: () => ({ success: 'yes' }) }]]) {
  test(`policy fail-closed: ${name}`, async () => {
    let invoked = 0;
    const result = await callDirect({ provider: 'fixture', tool: 'read', args: {} },
      [{ name: 'fixture', fns: { read: async () => ++invoked } }], { read: ['read'], validate: { read: validator } });
    assert.equal(invoked, 0, 'invalid arguments must not reach the current core host tool');
    assert.match(result.error, /invalid arguments/);
  });
}
