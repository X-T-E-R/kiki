import { describe, expect, it } from 'vitest';

import { mediaManagedSourceSchema, mediaSourceSettingPropertySchema } from '../media-management';

/** A source payload as the media service sends it, with one plain and one secret field. */
function source(properties: Record<string, unknown>) {
  return {
    provider: 'kiki-media/openai-image',
    sourceId: 'openai',
    pluginId: 'kiki-media',
    label: 'OpenAI Media',
    custom: false,
    enabled: true,
    removed: false,
    definitions: [{ schemaVersion: 1, id: 'openai-image', kinds: ['image'], label: 'OpenAI Images', resumeVersion: 1, connectionSetting: 'connectionId' }],
    schema: { schemaVersion: 1, schema: { type: 'object', properties, required: ['apiKey'] } },
    values: { baseUrl: 'https://api.openai.example.test/v1' },
    secretsConfigured: ['apiKey'],
    missing: [],
  };
}

describe('media source settings on the wire', () => {
  it('accepts the field metadata a package manifest declares, and keeps the values as the host reported them', () => {
    // Every field here is one the manifest schema accepts and the media service
    // copies verbatim into a source's own schema, so the two contracts have to
    // agree: a strict wire schema that drops one fails the whole settings read.
    const parsed = mediaManagedSourceSchema.safeParse(source({
      connectionId: { type: 'string', title: 'Kiki connection (optional)', description: 'Use a media-capable API connection.', group: 'openai', groupTitle: 'OpenAI Media', localizations: { zh: { title: 'Kiki 连接（可选）', description: '使用支持媒体的 API 连接。', groupTitle: 'OpenAI 媒体' }, 'zh-Hans': { title: '简体标题' } } },
      apiKey: { type: 'string', title: 'API key', secret: true, group: 'openai', groupTitle: 'OpenAI Media', localizations: { zh: { title: 'API 密钥' } } },
      baseUrl: { type: 'string', title: 'API base URL', default: 'https://api.openai.com/v1', group: 'openai', groupTitle: 'OpenAI Media', localizations: { zh: { title: 'API 基础地址' } } },
      imageModel: { type: 'string', title: 'Default image model', default: 'gpt-image-1.5', enum: ['gpt-image-1.5', 'gpt-image-2'], advanced: true, multiline: false, hidden: false },
    }));
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toEqual([]);
    const openai = parsed.data!;
    expect(openai.schema.schema.properties['apiKey']?.secret).toBe(true);
    expect(openai.schema.schema.properties['baseUrl']?.default).toBe('https://api.openai.com/v1');
    expect(openai.schema.schema.properties['baseUrl']?.localizations?.['zh']?.title).toBe('API 基础地址');
    expect(openai.schema.schema.properties['connectionId']?.localizations?.['zh-Hans']?.title).toBe('简体标题');
    expect(openai.schema.schema.properties['imageModel']?.enum).toEqual(['gpt-image-1.5', 'gpt-image-2']);
    expect(openai.values).toEqual({ baseUrl: 'https://api.openai.example.test/v1' });
    expect(openai.secretsConfigured).toEqual(['apiKey']);
  });

  it('keeps a legacy property readable, with no translation and no metadata', () => {
    const parsed = mediaManagedSourceSchema.safeParse(source({ apiKey: { type: 'string', title: 'API key', secret: true } }));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.schema.schema.properties['apiKey']?.localizations).toBeUndefined();
    expect(parsed.data?.schema.schema.properties['apiKey']?.title).toBe('API key');
  });

  it('rejects a property field the manifest cannot declare, and a malformed translation', () => {
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', title: 'API key', placeholder: 'sk-…' }).success).toBe(false);
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', localizations: { zh: 'API 密钥' } }).success).toBe(false);
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', localizations: { zh: { title: 'API 密钥', help: 'not a field' } } }).success).toBe(false);
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', localizations: { zh: { groupTitle: '' } } }).success).toBe(false);
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', enum: [] }).success).toBe(true);
    expect(mediaSourceSettingPropertySchema.safeParse({ type: 'string', group: '' }).success).toBe(false);
    // The strictness is what makes the mismatch loud instead of silent.
    expect(mediaManagedSourceSchema.safeParse({ ...source({ apiKey: { type: 'string', title: 'API key' } }), label: undefined }).success).toBe(false);
  });
});
