import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { recoveryFor } from '../lib/recovery.mjs';

const input = { hook_event_name: 'StopFailure', error_code: 'provider.api_error', upstream_error_code: 'antigravity_missing_terminal', recoverable: true, recovery_attempts: 0 };
const expected = { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };

test('requests exactly the user continuation on the first eligible missing-terminal failure', () => {
  assert.deepEqual(recoveryFor(input), expected);
  assert.equal(recoveryFor({ ...input, recovery_attempts: 1 }), undefined);
  assert.equal(recoveryFor({ ...input, recoverable: false }), undefined);
  assert.equal(recoveryFor({ ...input, hook_event_name: 'Stop' }), undefined);
});

test('does not guess from messages or recover other provider codes', () => {
  for (const code of ['antigravity_thinking_only', 'antigravity_empty_response', 'antigravity_max_tokens', 'antigravity_safety', 'antigravity_malformed_function_call', 'antigravity_malformed_response', 'antigravity_upstream_terminal_error', 'antigravity_stream_read_error', 'authentication_error', 'insufficient_quota', undefined]) {
    assert.equal(recoveryFor({ ...input, upstream_error_code: code, error_message: 'antigravity_missing_terminal' }), undefined);
  }
});

test('ships an installable hook command with no dependencies and exercises stdin/stdout', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'argon-error-recovery');
  assert.match(manifest.interface.displayName, /Unofficial/);
  assert.deepEqual(manifest.hooks, [{ event: 'StopFailure', command: 'node ./scripts/recover.mjs', timeout: 5 }]);
  const result = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  const noMatch = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify({ ...input, recoverable: false }), encoding: 'utf8' });
  assert.equal(noMatch.status, 0, noMatch.stderr);
  assert.equal(noMatch.stdout, '');
});
