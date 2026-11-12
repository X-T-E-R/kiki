import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import applyArgonPlugin, { registerArgonExtensionPorts } from '../lib/native.mjs';
import { recoveryFor } from '../lib/recovery.mjs';

const input = { hook_event_name: 'StopFailure', error_code: 'provider.api_error', upstream_error_code: 'antigravity_missing_terminal', recoverable: true, recovery_attempts: 0 };
const inputCodelessSse = {
  hook_event_name: 'StopFailure',
  error_code: 'provider.api_error',
  upstream_error_code: undefined,
  error_message: 'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer. [type=api_error]',
  recoverable: true,
  recovery_attempts: 0,
};
const gateway = { ...input, model_alias: 'axon-message/gemini-4-carbon', upstream_error_code: 'gateway_stream_terminal_error', error_details: { retry: false } };
const gatewayLegacy = { ...gateway, model_alias: 'axon-message/gemini-4-argon' };
const disconnected = { ...gateway, error_code: 'provider.connection_error', upstream_error_code: undefined, error_details: { retry: false, retry_exhausted: true } };
const expectedContinue = { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };
const expectedRetry = { hookSpecificOutput: { recovery: { action: 'retry' } } };
const matchingEvents = [input, inputCodelessSse, gateway, gatewayLegacy, disconnected];

for (const [name, event] of Object.entries({ missingTerminal: input, missingTerminalCodelessSse: inputCodelessSse, gateway, gatewayLegacy, disconnected })) {
  test(`chooses recovery for ${name} from retained partial output`, () => {
    assert.deepEqual(recoveryFor(event), expectedRetry);
    assert.deepEqual(recoveryFor({ ...event, has_partial_output: false }), expectedRetry);
    assert.deepEqual(recoveryFor({ ...event, has_partial_output: true }), expectedContinue);
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

test('registers only native E4 and E6 policies and disposes them in reverse order once', async () => {
  const registrations = [];
  const disposed = [];
  const ports = {
    registerRequestPolicy() { throw new Error('E2 should remain unregistered'); },
    registerRecoveryPolicy(pluginId, handler) {
      registrations.push({ slot: 'E4', pluginId, handler });
      return { dispose() { disposed.push('E4'); } };
    },
    registerCompactionPolicy(contribution) {
      registrations.push({ slot: 'E6', contribution });
      return { dispose() { disposed.push('E6'); } };
    },
  };

  const disposable = registerArgonExtensionPorts(ports);
  assert.deepEqual(registrations.map(({ slot }) => slot), ['E4', 'E6']);
  assert.deepEqual(registrations.map(({ pluginId, contribution }) => pluginId ?? contribution.pluginId), [
    'argon-error-recovery', 'argon-error-recovery',
  ]);
  await disposable.dispose();
  await disposable.dispose();
  assert.deepEqual(disposed, ['E6', 'E4']);
});

test('default Cordis apply binds extension-port disposal to its effect owner', async () => {
  const registrations = [];
  const effects = [];
  const disposals = [];
  const lookups = [];
  let release;
  const ports = {
    registerRecoveryPolicy(pluginId, handler) {
      registrations.push({ slot: 'E4', pluginId, handler });
      return { dispose() { disposals.push('E4'); } };
    },
    registerCompactionPolicy(contribution) {
      registrations.push({ slot: 'E6', contribution });
      return { dispose() { disposals.push('E6'); } };
    },
  };
  const ctx = {
    get(key) {
      lookups.push(key);
      return ports;
    },
    effect(factory) {
      effects.push('effect');
      release = factory();
    },
  };

  assert.equal(applyArgonPlugin(ctx), undefined);
  assert.deepEqual(lookups, ['kiki.extensionPorts']);
  assert.deepEqual(registrations.map(({ slot }) => slot), ['E4', 'E6']);
  assert.deepEqual(effects, ['effect']);
  assert.deepEqual(disposals, []);
  assert.equal(typeof release, 'function');
  await release();
  assert.deepEqual(disposals, ['E6', 'E4']);
});

test('default Cordis apply skips registration when extension ports are absent', () => {
  const effects = [];
  const ctx = {
    get(key) {
      assert.equal(key, 'kiki.extensionPorts');
      return undefined;
    },
    effect() {
      effects.push('effect');
    },
  };

  assert.equal(applyArgonPlugin(ctx), undefined);
  assert.deepEqual(effects, []);
});

test('continues only structured Argon failures within the supplied consecutive-recovery budget', async () => {
  const registrations = [];
  const disposable = registerArgonExtensionPorts({
    registerRecoveryPolicy(pluginId, handler) {
      registrations.push({ slot: 'E4', pluginId, handler });
      return { dispose() {} };
    },
    registerCompactionPolicy(contribution) {
      registrations.push({ slot: 'E6', contribution });
      return { dispose() {} };
    },
  });
  const policy = registrations.find(({ slot }) => slot === 'E4').handler;
  const snapshot = (overrides = {}) => ({
    sessionId: 'session', agentId: 'agent', turnId: 1, step: 1, logicalStepId: 't1.1', attempt: 1,
    deliveryPhase: 'sent_outcome_unknown', errorCode: 'provider.api_error', statusCode: 400,
    modelAlias: 'axon-message/gemini-4-argon', protocol: 'anthropic', providerType: 'anthropic',
    recoveryStreakCount: 0, maxRecoveryBudget: 1, errorMessage: 'untrusted text', ...overrides,
  });
  const expected = { action: 'enqueue_recovery_continuation', reminderText: '继续', variant: 'argon_error_recovery' };
  for (const failure of [
    { statusCode: 400 },
    { statusCode: 500 },
    { statusCode: undefined, providerErrorCode: 'antigravity_missing_terminal' },
    { statusCode: undefined, providerErrorCode: 'antigravity_empty_response' },
    { statusCode: undefined, providerErrorCode: 'gateway_stream_terminal_error' },
  ]) {
    assert.deepEqual(await policy(snapshot(failure), new AbortController().signal), expected);
  }
  for (const failure of [
    { modelAlias: 'example-model' },
    { protocol: 'openai' },
    { errorCode: 'provider.auth_error', statusCode: 500 },
    { statusCode: 401 },
    { statusCode: 429 },
    { statusCode: 502 },
    { statusCode: undefined, providerErrorCode: 'antigravity_thinking_only' },
    { recoveryStreakCount: 1 },
    { maxRecoveryBudget: 0 },
  ]) {
    assert.deepEqual(await policy(snapshot(failure), new AbortController().signal), { action: 'pass' });
  }
  await disposable.dispose();
});

test('E6 preserves only an existing transcript file index for native Argon compaction', async () => {
  const registrations = [];
  const disposable = registerArgonExtensionPorts({
    registerRecoveryPolicy(pluginId, handler) {
      registrations.push({ slot: 'E4', pluginId, handler });
      return { dispose() {} };
    },
    registerCompactionPolicy(contribution) {
      registrations.push({ slot: 'E6', contribution });
      return { dispose() {} };
    },
  });
  const policy = registrations.find(({ slot }) => slot === 'E6').contribution;
  assert.equal(policy.matches({ modelAlias: 'axon-message/gemini-4-argon', protocol: 'anthropic', source: 'auto' }), true);
  assert.equal(policy.matches({ modelAlias: 'example-model', protocol: 'anthropic', source: 'auto' }), false);
  assert.equal(policy.matches({ modelAlias: 'axon-message/gemini-4-argon', protocol: 'openai', source: 'auto' }), false);
  const fileIndex = '## Files read (content not carried)\nHistorical Read observations, not current file contents.\n- "src/example.ts" on "local" L1–L4/4 (80 chars returned by last Read) · HistoryRead {turn:1}';
  const history = [
    { role: 'user', content: [{ type: 'text', text: fileIndex }], origin: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: `## TODO List\n- Finish work\n\n${fileIndex}\n\n## Working notes\nKeep the current task.` }], origin: { kind: 'compaction_summary' } },
  ];
  assert.deepEqual(await policy.buildSummaryGuidance({
    sessionId: 'session', agentId: 'agent', history, compactCount: 2, signal: new AbortController().signal,
  }), {
    additionalInstructions: 'Keep the existing transcript file index as historical context; do not infer entries or treat it as current file contents.',
    preservedFileIndexMarkdown: fileIndex,
  });
  assert.equal(await policy.buildSummaryGuidance({
    sessionId: 'session', agentId: 'agent', history: [history[0]], compactCount: 1, signal: new AbortController().signal,
  }), undefined);
  assert.equal(await policy.buildSummaryGuidance({
    sessionId: 'session', agentId: 'agent', history: [{ ...history[1], content: [{ type: 'text', text: '## Files read (content not carried)\n' }] }],
    compactCount: 1, signal: new AbortController().signal,
  }), undefined);
  await disposable.dispose();
});

test('ships an installable dependency-free hook and exercises real stdin/stdout', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'argon-error-recovery');
  assert.equal(manifest.version, '0.3.0');
  assert.equal(pkg.version, manifest.version);
  assert.match(manifest.interface.displayName, /Unofficial/);
  assert.deepEqual(manifest.hooks, [{ event: 'StopFailure', command: 'node ./scripts/recover.mjs', timeout: 5 }]);
  for (const event of matchingEvents) {
    for (const { event: inputEvent, expected } of [
      { event: { ...event, has_partial_output: true }, expected: expectedContinue },
      { event: { ...event, has_partial_output: false }, expected: expectedRetry },
      { event, expected: expectedRetry },
    ]) {
      const result = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify(inputEvent), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
  }
  for (const event of [{ ...gateway, recoverable: false }, { ...gateway, recovery_attempts: 1 }, { ...gateway, model_alias: 'example-model' }]) {
    const result = spawnSync(process.execPath, ['./scripts/recover.mjs'], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});
