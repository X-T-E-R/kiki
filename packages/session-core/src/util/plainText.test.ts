import { describe, expect, it } from 'vitest';

import { firstSentence } from './plainText';

describe('firstSentence', () => {
  it('drops emphasis and code marks and ends at the first stop', () => {
    expect(firstSentence('**本轮完成了 SSH 的指纹封口、会话主机管理。** 临时登录未完成。')).toBe('本轮完成了 SSH 的指纹封口、会话主机管理。');
    expect(firstSentence('Updated `auto_compact` in [the doc](x.md). Next.')).toBe('Updated auto_compact in the doc.');
  });

  it('skips headings, rules, tables and fenced code', () => {
    expect(firstSentence('## 1) `auto_compact.override`\n\n```ts\nconst a = 1.\n```\n---\n| a | b |\n- 完成。三项漂移全部收敛')).toBe('完成。');
  });

  it('returns an empty string when there is no prose', () => {
    expect(firstSentence('# Title\n```\ncode\n```')).toBe('');
  });
});
