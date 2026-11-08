import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseTargetModels, resolvePluginProjectionPolicy } from '../lib/policy.mjs';

test('manifest declares requestProjection and settings for argon-tool-result-appendix', async () => {
  const raw = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(raw.name, 'argon-tool-result-appendix');
  assert.equal(raw['x-kiki']?.requestProjection?.defaultStrategy, 'tool_result_appendix');
  assert.deepEqual(raw['x-kiki']?.requestProjection?.defaultModels, ['axon-message/gemini-4-argon']);
  assert.deepEqual(
    raw['x-kiki']?.settings?.schema?.properties?.strategy?.enum,
    ['passthrough', 'tool_result_appendix'],
  );
});

test('policy matches only explicitly configured Argon models and respects disabled scopes', () => {
  assert.deepEqual(
    resolvePluginProjectionPolicy({
      modelAlias: 'axon-message/gemini-4-argon',
    }),
    { strategy: 'tool_result_appendix' },
  );
  assert.deepEqual(
    resolvePluginProjectionPolicy({
      modelAlias: 'axon-message/gemini-3.8-flash',
    }),
    { strategy: 'passthrough' },
  );
  assert.deepEqual(
    resolvePluginProjectionPolicy({
      enabled: false,
      modelAlias: 'axon-message/gemini-4-argon',
    }),
    { strategy: 'passthrough' },
  );
  assert.deepEqual(
    resolvePluginProjectionPolicy({
      scopeAllowed: false,
      modelAlias: 'axon-message/gemini-4-argon',
    }),
    { strategy: 'passthrough' },
  );
  assert.deepEqual(
    parseTargetModels('axon-message/gemini-4-argon, custom/argon-v2\n'),
    ['axon-message/gemini-4-argon', 'custom/argon-v2'],
  );
});
