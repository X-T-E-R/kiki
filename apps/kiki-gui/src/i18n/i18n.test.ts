import { describe, expect, it } from 'vitest';

import { en } from './en';
import { zh } from './zh';
import {
  detectLocale,
  errorText,
  LocalizedError,
  translate,
  translatePlural,
  type I18nKey,
} from './locale';
import { formatDuration, relativeTime, timeUntil } from '../lib/time';

describe('detectLocale', () => {
  it('honors a stored explicit choice over the browser language', () => {
    expect(detectLocale({ stored: 'zh', navigatorLanguage: 'en-US' })).toBe('zh');
    expect(detectLocale({ stored: 'en', navigatorLanguage: 'zh-CN' })).toBe('en');
  });

  it('maps any zh* browser language to Chinese', () => {
    expect(detectLocale({ stored: null, navigatorLanguage: 'zh-CN' })).toBe('zh');
    expect(detectLocale({ stored: null, navigatorLanguage: 'zh-TW' })).toBe('zh');
    expect(detectLocale({ stored: undefined, navigatorLanguage: 'zh' })).toBe('zh');
  });

  it('falls back to English for other or missing browser languages', () => {
    expect(detectLocale({ stored: null, navigatorLanguage: 'fr-FR' })).toBe('en');
    expect(detectLocale({ stored: null, navigatorLanguage: null })).toBe('en');
    expect(detectLocale({})).toBe('en');
  });

  it('ignores a stored value that is not a known locale', () => {
    expect(detectLocale({ stored: 'fr', navigatorLanguage: 'zh-CN' })).toBe('zh');
  });
});

describe('translate', () => {
  it('returns the template for the requested locale', () => {
    expect(translate('en', 'sidebar.newSession')).toBe('New session');
    expect(translate('zh', 'sidebar.newSession')).toBe('新会话');
  });

  it('interpolates {params} and leaves unknown placeholders intact', () => {
    expect(translate('en', 'sidebar.noMatches', { query: 'persimmon' })).toBe(
      'No matches for “persimmon”.',
    );
    expect(translate('zh', 'sidebar.noMatches', { query: '柿子' })).toBe('没有匹配“柿子”的结果。');
    expect(translate('en', 'sidebar.noMatches', {})).toBe('No matches for “{query}”.');
  });

  it('falls back to English when a locale misses a key, then to the key itself', () => {
    const missing = 'sidebar.newSession' as I18nKey;
    const dictionaries = zh as Partial<Record<I18nKey, string>>;
    const original = dictionaries[missing];
    delete dictionaries[missing];
    try {
      expect(translate('zh', missing)).toBe('New session');
    } finally {
      dictionaries[missing] = original;
    }
    expect(translate('en', 'no.such.key' as I18nKey)).toBe('no.such.key');
  });
});

describe('translatePlural', () => {
  it('picks one/other forms in English and the shared form in Chinese', () => {
    expect(translatePlural('en', 'sv.queueBar', 1)).toContain('1 prompt queued');
    expect(translatePlural('en', 'sv.queueBar', 3)).toContain('3 prompts queued');
    expect(translatePlural('zh', 'sv.queueBar', 1)).toContain('1 条消息已排队');
    expect(translatePlural('zh', 'sv.queueBar', 3)).toContain('3 条消息已排队');
    expect(translatePlural('en', 'st.plugins.contrib.skills', 1)).toBe('1 skill');
    expect(translatePlural('en', 'st.plugins.contrib.skills', 2)).toBe('2 skills');
    expect(translatePlural('en', 'st.plugins.contrib.mcp', 1)).toBe('1 MCP server');
    expect(translatePlural('en', 'st.plugins.contrib.commands', 2)).toBe('2 commands');
    expect(translatePlural('zh', 'st.plugins.contrib.skills', 1)).toBe('1 个技能');
    expect(translatePlural('zh', 'st.plugins.contrib.skills', 2)).toBe('2 个技能');
  });
});

describe('dictionary parity', () => {
  it('zh covers every en key with a non-empty string', () => {
    for (const key of Object.keys(en) as I18nKey[]) {
      expect(zh[key], `missing zh translation for ${key}`).toBeTypeOf('string');
      expect(zh[key].trim(), `empty zh translation for ${key}`).not.toBe('');
    }
  });

  it('zh has no keys that en lacks', () => {
    for (const key of Object.keys(zh)) {
      expect(Object.hasOwn(en, key), `unexpected zh key ${key}`).toBe(true);
    }
  });

  it('both locales declare the same {placeholders} per key', () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(en) as I18nKey[]) {
      expect(placeholders(zh[key]), `placeholder mismatch for ${key}`).toEqual(
        placeholders(en[key]),
      );
    }
  });
});

describe('LocalizedError / errorText', () => {
  it('carries an English message while rendering per-locale via the issue', () => {
    const error = new LocalizedError({ key: 'val.flagBool', params: { name: 'search_worker' } });
    expect(error.message).toBe('Experimental flag "search_worker" must be true or false.');
    expect(errorText('zh', error)).toBe('实验开关“search_worker”必须为 true 或 false。');
    expect(errorText('en', error)).toBe(error.message);
  });

  it('passes plain errors and unknown values through', () => {
    expect(errorText('zh', new Error('boom'))).toBe('boom');
    expect(errorText('zh', 'string failure')).toBe('string failure');
  });
});

describe('localized time', () => {
  // Offsets are evaluated at call time; the countdown assertions pad by half
  // a second so floor() never lands one unit short.
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  it('renders relative phrasing per locale', () => {
    expect(relativeTime(iso(-5_000), 'en')).toBe('just now');
    expect(relativeTime(iso(-5_000), 'zh')).toBe('刚刚');
    expect(relativeTime(iso(-45_000), 'en')).toBe('45s ago');
    expect(relativeTime(iso(-45_000), 'zh')).toBe('45 秒前');
    expect(relativeTime(iso(-3_600_000 * 5), 'zh')).toBe('5 小时前');
    expect(relativeTime(iso(-3_600_000 * 24 * 3), 'zh')).toBe('3 天前');
  });

  it('renders countdown phrasing per locale', () => {
    expect(timeUntil(iso(30_500), 'en')).toBe('30s left');
    expect(timeUntil(iso(30_500), 'zh')).toBe('剩余 30 秒');
    expect(timeUntil(iso(-1_000), 'en')).toBe('expired');
    expect(timeUntil(iso(-1_000), 'zh')).toBe('已过期');
  });

  it('renders durations per locale', () => {
    expect(formatDuration(850, 'en')).toBe('850ms');
    expect(formatDuration(850, 'zh')).toBe('850毫秒');
    expect(formatDuration(65_000, 'en')).toBe('1m 5s');
    expect(formatDuration(65_000, 'zh')).toBe('1分5秒');
    expect(formatDuration(2_500, 'zh')).toBe('2.5秒');
  });

  it('defaults to English when no locale is given', () => {
    expect(relativeTime(iso(-5_000))).toBe('just now');
    expect(formatDuration(850)).toBe('850ms');
  });
});
