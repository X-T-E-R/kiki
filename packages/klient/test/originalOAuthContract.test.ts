import { expect, it } from 'vitest';
import { providerConfigSchema } from '../src/contract/global/providers.js';
import { modelConfigSchema } from '../src/contract/global/models.js';

it('keeps the official original source through provider and model public wire contracts', () => {
  const source = { kind: 'local_original', provider: 'grok-build', homeDir: 'C:/synthetic/grok', storageBackend: 'file', authFile: 'C:/synthetic/grok/auth.json', accountId: 'account-a' } as const;
  const oauth = { storage: 'file', key: 'oauth/grok-build', source } as const;
  expect(providerConfigSchema.parse({ type: 'openai', oauth }).oauth?.source).toEqual(source);
  expect(modelConfigSchema.parse({ model: 'grok-example', provider: 'managed:grok-build', oauth }).oauth?.source).toEqual(source);
  expect(providerConfigSchema.safeParse({ type: 'openai', oauth: { ...oauth, source: { ...source, refreshToken: 'forbidden' } } }).success).toBe(false);
});
