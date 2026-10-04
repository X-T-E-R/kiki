import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAccess } from '../src/services/webAccess';

describe('Web session lifecycle', () => {
  let home: string; let now: number; let web: WebAccess; let closed: number; let id: string;
  const day = 24 * 60 * 60 * 1000;
  const start = async () => ({ url: 'https://example.test', host: '127.0.0.1', port: 58627, close: async () => { closed++; } });
  const request = (cookie?: string, origin = 'https://example.test', method = 'POST') => ({ method, headers: { host: 'example.test', origin, cookie } }) as IncomingMessage;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'kiki-web-session-')); now = 1000000; closed = 0; id = randomUUID(); web = new WebAccess(home, id, start, () => now); });
  afterEach(async () => { vi.useRealTimers(); await web.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  const code = (url: string) => new URL(url).hash.slice('#access='.length);
  it('requires exact same origin before consuming an expiring single-use code and atomically rejects concurrent exchange', async () => {
    await web.enable({ mode: 'temporary', publicUrl: 'https://example.test' });
    const link = web.issueLink();
    await expect(web.exchange(code(link.url), request(undefined, 'http://example.test'))).rejects.toThrow('web_origin_not_allowed');
    await expect(web.exchange(code(link.url), request(undefined, 'https://example.test:443'))).rejects.toThrow('web_origin_not_allowed');
    const results = await Promise.allSettled([web.exchange(code(link.url), request()), web.exchange(code(link.url), request())]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const good = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ cookie: string }>;
    expect(good.value.cookie).toContain('; Secure'); expect(good.value.cookie).not.toContain('Domain=');
    const expired = web.issueLink(); now += 600000;
    await expect(web.exchange(code(expired.url), request())).rejects.toThrow('invalid_web_access_code');
  });
  it('persists only session digests, applies 30-day idle expiry and does not persist temporary sessions', async () => {
    await web.enable({ mode: 'persistent', publicUrl: 'https://example.test' });
    const exchanged = await web.exchange(code(web.issueLink().url), request(), 'Test browser');
    const cookie = exchanged.cookie.split(';')[0]!;
    const file = await readFile(join(home, 'server', 'web-access.json'), 'utf8'); expect(file).not.toContain(cookie.split('=')[1]!);
    const closeLease = vi.fn(); web.attach(web.authenticate(request(cookie, 'https://example.test', 'GET')), closeLease);
    now += 29 * day; expect(web.current(request(cookie))).not.toBeNull();
    await web.close(); expect(closeLease).toHaveBeenCalledOnce();
    web = new WebAccess(home, id, start, () => now); await web.ready(); expect(web.current(request(cookie))).not.toBeNull();
    now += 30 * day; expect(web.current(request(cookie))).toBeNull(); expect(web.status().sessions).toEqual([]);
    await web.enable({ mode: 'temporary', publicUrl: 'https://example.test' });
    await web.exchange(code(web.issueLink().url), request()); expect(JSON.parse(await readFile(join(home, 'server', 'web-access.json'), 'utf8'))).toEqual({});
  });
  it('closes temporary leases/listener at expiry without restoring access on reopen', async () => {
    vi.useFakeTimers(); await web.close(); web = new WebAccess(home, id, start, () => now);
    await web.enable({ mode: 'temporary', publicUrl: 'https://example.test' });
    const entry = await web.exchange(code(web.issueLink().url), request()); const cookie = entry.cookie.split(';')[0]!;
    const close = vi.fn(); web.attach(web.authenticate(request(cookie)), close);
    now += 8 * 60 * 60 * 1000; await vi.advanceTimersByTimeAsync(60000);
    expect(web.status().enabled).toBe(false); expect(close).toHaveBeenCalledOnce(); expect(closed).toBeGreaterThan(0);
    await web.enable({ mode: 'temporary', publicUrl: 'https://example.test' }); expect(web.current(request(cookie))).toBeNull();
  });
});
