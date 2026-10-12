import { describe, expect, it } from 'vitest';

import { localizeSettingText } from './settingText';

describe('localizeSettingText', () => {
  const translated = {
    title: 'API base URL',
    description: 'Where requests go.',
    groupTitle: 'OpenAI Media',
    localizations: { zh: { title: 'API 基础地址', description: '请求发送到的地址。' }, 'zh-Hans': { title: '简体标题' } },
  };

  it('reads the reader\'s language, field by field, and falls back to the manifest\'s own string', () => {
    expect(localizeSettingText(translated, 'zh')).toEqual({ title: 'API 基础地址', description: '请求发送到的地址。', groupTitle: 'OpenAI Media' });
    // A language the property does not spell out falls back entirely.
    expect(localizeSettingText(translated, 'en')).toEqual({ title: 'API base URL', description: 'Where requests go.', groupTitle: 'OpenAI Media' });
    // Untranslated fields inside a translated language keep their own text.
    expect(localizeSettingText({ title: 'API key', description: 'Kept as written.', localizations: { zh: { title: 'API 密钥' } } }, 'zh').description).toBe('Kept as written.');
    // A property with no translations at all is its own text.
    expect(localizeSettingText({ title: 'API key' }, 'zh')).toEqual({ title: 'API key', description: undefined, groupTitle: undefined });
    expect(localizeSettingText({}, 'zh')).toEqual({ title: undefined, description: undefined, groupTitle: undefined });
  });

  it('answers a regional tag from the same primary language', () => {
    expect(localizeSettingText(translated, 'zh-CN').title).toBe('API 基础地址');
    expect(localizeSettingText(translated, 'zh-Hans').title).toBe('简体标题');
    // The exact tag wins over the primary-language match beside it.
    expect(localizeSettingText(translated, 'zh-Hant').title).toBe('API 基础地址');
    expect(localizeSettingText({ title: 'Endpoint', localizations: { 'zh-Hans': { title: '端点' } } }, 'zh-TW').title).toBe('端点');
  });
});
