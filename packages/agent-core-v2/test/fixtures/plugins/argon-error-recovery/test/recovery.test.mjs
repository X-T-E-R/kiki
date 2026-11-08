import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { recoveryFor } from '../lib/recovery.mjs';

const input = { hook_event_name: 'StopFailure', error_code: 'provider.api_error', upstream_error_code: 'antigravity_missing_terminal', recoverable: true, recovery_attempts: 0 };
const gateway = { ...input, model_alias: 'axon-message/gemini-4-argon', upstream_error_code: 'gateway_stream_terminal_error', error_details: { retry: false } };
const disconnected = { ...gateway, error_code: 'provider.connection_error', upstream_error_code: undefined, error_details: { retry: false, retry_exhausted: true } };
const expected = { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };

for (const [name, event] of Object.entries({ missingTerminal: input, gateway, disconnected })) {
  test(`continues ${name} exactly once when the host permits it`, () => {
    assert.deepEqual(recoveryFor(event), expected);
    for (const attempts of [1, 2, undefined]) assert.equal(recoveryFor({ ...event, recovery_attempts: attempts }), undefined);
    assert.equal(recoveryFor({ ...event, recoverable: false }), undefined);
    assert.equal(recoveryFor({ ...event, hook_event_name: 'Stop' }), undefined);
  });
}

test('limits newly supported failures to the host-supplied Argon alias', () => {
  for (const event of [gateway, disconnected]) {
    for (const model_alias of ['example-model', 'other/gemini-4-argon', undefined]) {
      assert.equal(recoveryFor({ ...event, model_alias, error_message: 'axon-message/gemini-4-argon', profile_name: 'argon' }), undefined);
    }
  }
  assert.equal(recoveryFor({ ...disconnected, error_details: { retry: false } }), undefined);
});

test('does not guess from messages or take over unrelated provider errors', () => {
  for (const code of ['antigravity_thinking_only', 'antigravity_empty_response', 'antigravity_max_tokens', 'antigravity_safety', 'antigravity_malformed_function_call', 'antigravity_malformed_response', 'antigravity_upstream_terminal_error', 'antigravity_stream_read_error', 'authentication_error', 'insufficient_quota', undefined]) {
    assert.equal(recoveryFor({ ...gateway, upstream_error_code: code, error_message: 'antigravity_missing_terminal' }), undefined);
  }
});

test('ships an installable dependency-free hook and exercises real stdin/stdout', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'argon-error-recovery');
  assert.equal(manifest.version, '0.2.1');
  assert.equal(pkg.version, manifest.version);
  assert.match(manifest.interface.displayName, /Unofficial/);
  assert.deepEqual(manifest.hooks, [{ event: 'StopFailure', command: 'node ./scripts/recover.mjs', timeout: 5 }]);
  for (const event of [input, gateway, disconnected]) {
    const result = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  for (const event of [{ ...gateway, recoverable: false }, { ...gateway, recovery_attempts: 1 }, { ...gateway, model_alias: 'example-model' }]) {
    const result = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});
