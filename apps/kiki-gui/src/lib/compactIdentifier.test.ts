import { describe, expect, it } from 'vitest';

import {
  compactIdentifier,
  compactMiddle,
  compactSessionId,
  formatImIdentityDisplay,
  formatSessionOwnerLabel,
} from './compactIdentifier';

describe('compactIdentifier', () => {
  it('middle-ellipsizes WeChat JIDs, Feishu open/chat IDs, session UUIDs, and long numeric account IDs', () => {
    expect(compactIdentifier('o0aa11bBcCdDeEfFgGhHiIjJkKlL@im.wechat')).toBe('o0aa…JkLl'.replace('JkLl', 'kKlL'));
    expect(compactIdentifier('oc_11223344556677889900aabbccddeeff')).toBe('oc_1122…eeff');
    expect(compactIdentifier('ou_b9781234567890abcdef1234567890ab')).toBe('ou_b978…90ab');
    expect(compactIdentifier('8192037465')).toBe('8192…7465');
    expect(compactIdentifier('-4019283746')).toBe('-4019…3746');
    expect(compactIdentifier('12345678')).toBe('123…678');
    expect(compactIdentifier('session_ffc09b7f-a341-40a2-8c11-99887766a63d')).toBe('ffc0…a63d');
    expect(compactIdentifier('wd_sampleproj_1a2b3c4d5e6f')).toBe('sampleproj · 1a2b…');
    expect(compactIdentifier('sk-proj-1234567890abcdef1234567890abcdef')).toBe('sk-1234…cdef');
  });

  it('preserves human names, CJK labels, normal emails, hostnames, IP:port endpoints, and readable slugs', () => {
    expect(compactIdentifier('Alex Rivera')).toBe('Alex Rivera');
    expect(compactIdentifier('工程日常群')).toBe('工程日常群');
    expect(compactIdentifier('user@example.test')).toBe('user@example.test');
    expect(compactIdentifier('@team:example.test')).toBe('@team:example.test');
    expect(compactIdentifier('acme-box')).toBe('acme-box');
    expect(compactIdentifier('release-notes')).toBe('release-notes');
    expect(compactIdentifier('ubuntu-server-1')).toBe('ubuntu-server-1');
    expect(compactIdentifier('devbox-01.internal')).toBe('devbox-01.internal');
    expect(compactIdentifier('192.0.2.10:22')).toBe('192.0.2.10:22');
    expect(compactIdentifier('[2001:db8::1]:8443')).toBe('[2001:db8::1]:8443');
    expect(compactIdentifier('acme-account-1')).toBe('acme-account-1');
    expect(compactIdentifier('implementer-v2')).toBe('implementer-v2');
    expect(compactIdentifier('provider/example-model-preview')).toBe('provider/example-model-preview');
    expect(compactIdentifier('-1001')).toBe('-1001');
    expect(compactIdentifier('8080')).toBe('8080');
  });

  it('still middle-ellipsizes unprefixed hex digests, ULIDs, SSH key fingerprints, and random WeChat IDs', () => {
    expect(compactIdentifier('11223344556677889900aabbccddeeff')).toBe('1122…eeff');
    expect(compactIdentifier('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01AR…5FAV');
    expect(compactIdentifier('SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8')).toBe('SHA256:nThb…5SY8');
    expect(compactIdentifier('wxid_0a9b8c7d6e5f4a3b2c1d')).toBe('wxid_0a9b…2c1d');
    expect(compactIdentifier('wxid_alice')).toBe('wxid_alice');
  });

  it('prefers real session titles and falls back to compact session IDs only when untitled', () => {
    expect(formatSessionOwnerLabel('session_ffc09b7f-a341-40a2-8c11-99887766a63d', 'Research')).toBe('Research');
    expect(formatSessionOwnerLabel(
      'session_ffc09b7f-a341-40a2-8c11-99887766a63d',
      'session_ffc09b7f-a341-40a2-8c11-99887766a63d',
    )).toBe('ffc0…a63d');
    expect(formatSessionOwnerLabel('session_ab2e5500-a11c-47b6-b123-445566778899', undefined)).toBe('ab2e…8899');
    expect(compactSessionId('ffc09b7f-a341-40a2-8c11-99887766a63d')).toBe('ffc0…a63d');
    expect(compactMiddle('abcdef', 4, 4)).toBe('abcdef');
  });

  it('formats IM identities with human titles first and never repeats bare IDs across primary and secondary lines', () => {
    const wechatRaw = formatImIdentityDisplay({
      chat_id: 'o0aa11bBcCdDeEfFgGhHiIjJkKlL@im.wechat',
      sender_id: 'o0aa11bBcCdDeEfFgGhHiIjJkKlL@im.wechat',
      topic_id: '0',
    });
    expect(wechatRaw.primary).toBe('o0aa…kKlL');
    expect(wechatRaw.secondary).toBeUndefined();
    expect(wechatRaw.fullTitle).toContain('o0aa11bBcCdDeEfFgGhHiIjJkKlL@im.wechat');

    const feishuRaw = formatImIdentityDisplay({
      chat_id: 'oc_11223344556677889900aabbccddeeff',
      sender_id: 'ou_b9781234567890abcdef1234567890ab',
      topic_id: '0',
    });
    expect(feishuRaw.primary).toBe('oc_1122…eeff · ou_b978…90ab');
    expect(feishuRaw.secondary).toBeUndefined();

    const tgDirect = formatImIdentityDisplay({
      chat_id: '8192037465',
      chat_title: '8192037465',
      sender_id: '8192037465',
      sender_name: 'Alex Rivera',
      topic_id: '0',
    });
    expect(tgDirect.primary).toBe('Alex Rivera');
    expect(tgDirect.secondary).toBe('8192…7465');

    const tgGroup = formatImIdentityDisplay({
      chat_id: '-4019283746',
      chat_title: '工程日常群',
      sender_id: '8192037465',
      sender_name: 'Alex Rivera',
      topic_id: '0',
    });
    expect(tgGroup.primary).toBe('工程日常群 · Alex Rivera');
    expect(tgGroup.secondary).toBe('-4019…3746');
  });
});
