import { describe, expect, it } from 'vitest';
import { LocalOriginalOAuthSourceRefSchema } from '@kiki/oauth';
import { OAuthRefSchema, modelsFromToml, modelsToToml, providersFromToml, providersToToml } from '#/app/kosongConfig/configSection';

const source = { kind: 'local_original', provider: 'openai-codex', homeDir: 'C:/synthetic/codex',
  storageBackend: 'encrypted', authFile: 'C:/synthetic/codex/secrets/codex_auth.age', accountId: 'account-a', userId: 'user-a' } as const;
const oauth = { storage: 'file', key: 'oauth/openai-codex', source } as const;

describe('original OAuth config projection', () => {
  it('round trips the single official source schema through provider and model TOML', () => {
    const providers = { 'managed:openai-codex': { type: 'openai_responses', oauth, requestIdentity: { profile: 'none' } } };
    const raw = providersToToml(providers, undefined) as Record<string, Record<string, unknown>>;
    expect(raw['managed:openai-codex']!['oauth']).toEqual({ storage: 'file', key: 'oauth/openai-codex', source: {
      kind: 'local_original', provider: 'openai-codex', home_dir: source.homeDir, storage_backend: 'encrypted', auth_file: source.authFile, account_id: 'account-a', user_id: 'user-a',
    } });
    expect(providersFromToml(raw)).toEqual(providers);
    const models = { model: { model: 'gpt-5.5', provider: 'managed:openai-codex', oauth } };
    expect(modelsFromToml(modelsToToml(models, undefined))).toEqual(models);
    expect(OAuthRefSchema.parse(oauth).source).toEqual(source);
    expect(LocalOriginalOAuthSourceRefSchema.safeParse({ ...source, refreshToken: 'must-not-be-stored-here' }).success).toBe(false);
  });
});
