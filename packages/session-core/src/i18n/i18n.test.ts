import { describe, expect, it } from 'vitest';

import { en } from './en';
import { zh } from './zh';
import { sessionActionErrorText } from '../commands/sessionActions';
import {
  detectLocale,
  errorText,
  LocalizedError,
  translate,
  translatePlural,
  type I18nKey,
} from './locale';
import { ApiError } from '../transport';
import { formatDuration, relativeTime, timeUntil } from '../util/time';

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
    expect(translate('en', 'diagnostics.unconfigured')).toBe('No recommendations');
    expect(translate('zh', 'diagnostics.unconfigured')).toBe('未配置推荐');
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
    expect(translatePlural('en', 'sv.queueBar', 1)).toBe('1 queued');
    expect(translatePlural('en', 'sv.queueBar', 3)).toBe('3 queued');
    expect(translatePlural('zh', 'sv.queueBar', 1)).toBe('1 条排队');
    expect(translatePlural('zh', 'sv.queueBar', 3)).toBe('3 条排队');
    expect(translatePlural('en', 'sv.queueBar', 1)).not.toContain('current turn');
    expect(translatePlural('zh', 'sv.queueBar', 1)).not.toContain('当前轮次');
    expect(translatePlural('en', 'st.plugins.contrib.skills', 1)).toBe('1 skill');
    expect(translatePlural('en', 'st.plugins.contrib.skills', 2)).toBe('2 skills');
    expect(translatePlural('en', 'st.plugins.contrib.mcp', 1)).toBe('1 MCP server');
    expect(translatePlural('en', 'st.plugins.contrib.commands', 2)).toBe('2 commands');
    expect(translatePlural('zh', 'st.plugins.contrib.skills', 1)).toBe('1 个技能');
    expect(translatePlural('zh', 'st.plugins.contrib.skills', 2)).toBe('2 个技能');
  });
});

describe('dictionary parity', () => {
  // zh is Partial (batch translation); only present entries must be non-empty.
  it('present zh translations are non-empty strings', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value, `non-string zh translation for ${key}`).toBeTypeOf('string');
      expect(value!.trim(), `empty zh translation for ${key}`).not.toBe('');
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
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const translated = (zh as Partial<Record<I18nKey, string>>)[key];
      if (translated === undefined) continue;
      expect(placeholders(translated), `placeholder mismatch for ${key}`).toEqual(
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

  it('keeps dictionary-looking field parameters literal in both locales', () => {
    const field = 'st.resourceLimits.imageMaxEdge';
    expect(translate('en', 'val.runtimePositive', { field })).toBe(
      `${field} must be a positive whole number within the supported range.`,
    );
    expect(translate('zh', 'val.runtimePositive', { field })).toBe(`${field} 必须是支持范围内的正整数。`);
    const error = new LocalizedError({ key: 'val.runtimePositive', params: { field } });
    expect(errorText('en', error)).toContain(field);
    expect(errorText('zh', error)).toContain(field);
  });

  it('renders explicitly marked validation labels in both locales', () => {
    const error = new LocalizedError({
      key: 'val.runtimePositive',
      labelKeys: { field: 'st.resourceLimits.imageMaxEdge' },
    });
    expect(error.message).toBe('Image maximum edge (px) must be a positive whole number within the supported range.');
    expect(errorText('zh', error)).toBe('图片最长边（像素） 必须是支持范围内的正整数。');
  });

  it('passes plain errors and unknown values through', () => {
    expect(errorText('zh', new Error('boom'))).toBe('boom');
    expect(errorText('zh', 'string failure')).toBe('string failure');
  });

  it('maps known server codes to localized copy, keeping unknown codes raw', () => {
    const workspaceGone = { code: 40410, message: 'workspace not found: wd_fixture_000000000001 (code 40410)' };
    expect(errorText('zh', workspaceGone)).toBe('工作区已经不存在了');
    expect(errorText('en', workspaceGone)).toBe('That workspace no longer exists');
    const identitySeed = { code: 40426, message: 'no request identity seed (code 40426)' };
    expect(errorText('zh', identitySeed)).toBe('找不到请求身份；请在「模型与提供商 › 身份」中重新设置');
    const sessionGone = { code: 40401, message: 'session.not_found (code 40401)' };
    expect(errorText('zh', sessionGone)).toBe('会话已经不存在了');
    const unmapped = { code: 40917, message: 'goal objective is empty (code 40917)' };
    expect(errorText('zh', unmapped)).toBe('goal objective is empty (code 40917)');
    expect(errorText('zh', new Error('something else (code 42901)'))).toBe('请求太频繁了，请稍后再试');
  });

  it('keeps validation refusal messages for ApiError objects and legacy suffixes', () => {
    const refusals = [
      { code: 40001, message: 'Choose a profile Markdown (.md) file' },
      { code: 40002, message: 'Malformed request: profile data is missing' },
    ] as const;
    for (const locale of ['en', 'zh'] as const) {
      for (const refusal of refusals) {
        const error = new ApiError({ code: refusal.code, msg: refusal.message, data: null });
        expect(errorText(locale, error)).toBe(error.message);
        const legacy = `${refusal.message} (code${refusal.code})`;
        expect(errorText(locale, legacy)).toBe(legacy);
      }
    }
  });

  it('keeps session action copy localized and unknown refusal text raw', () => {
    const undoUnavailable = new ApiError({ code: 40911, msg: 'undo unavailable', data: null });
    expect(sessionActionErrorText('en', undoUnavailable)).toBe(translate('en', 'error.nothingToUndo'));
    expect(sessionActionErrorText('zh', undoUnavailable)).toBe(translate('zh', 'error.nothingToUndo'));
    const refusal = new ApiError({ code: 40001, msg: 'Archive refused: drafts remain', data: null });
    expect(sessionActionErrorText('en', refusal)).toBe(refusal.message);
  });

  it('never prints a zod issue array as JSON', () => {
    const drift = { name: 'ZodError', issues: [{ code: 'invalid_type', path: ['advisor_status'], message: 'Invalid input' }] };
    expect(errorText('zh', drift)).toBe('服务器返回的记忆顾问数据无法识别');
    expect(errorText('en', drift)).toBe('The server returned memory advisor data Kiki could not read');
    const generic = { name: 'ZodError', issues: [{ code: 'invalid_type', path: ['models'], message: 'Invalid input' }] };
    expect(errorText('zh', generic)).toBe('服务器返回了无法识别的数据');
    // The same drift stringified by an upstream producer is still caught.
    const stringified = '[ { "expected": "object", "code": "invalid_type", "path": [ "advisor_status" ], "message": "Invalid input" } ]';
    expect(errorText('zh', stringified)).toBe('服务器返回的记忆顾问数据无法识别');
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
    expect(formatDuration(81_090_000, 'zh')).toBe('22小时31分');
    expect(formatDuration(81_090_000, 'en')).toBe('22h 31m');
    expect(formatDuration(93_600_000, 'zh')).toBe('1天 2小时');
    expect(formatDuration(3_599_000, 'zh')).toBe('59分59秒');
  });

  it('defaults to English when no locale is given', () => {
    expect(relativeTime(iso(-5_000))).toBe('just now');
    expect(formatDuration(850)).toBe('850ms');
  });
});
