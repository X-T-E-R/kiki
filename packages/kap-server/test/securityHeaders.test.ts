import { KIKI_APP_CSP } from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';

function captureHeaders() {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return reply;
    },
  };
  return { headers, reply };
}

function bareRequest(): never {
  return { routeOptions: { config: {} } } as never;
}

function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    directives.set(tokens[0] as string, tokens.slice(1));
  }
  return directives;
}

describe('createSecurityHeadersHook', () => {
  it('stamps the defensive headers and returns the payload unchanged', async () => {
    const { headers, reply } = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    const payload = { ok: true };
    const result = await hook(bareRequest(), reply as never, payload);
    expect(result).toBe(payload);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('content-security-policy')).toBeDefined();
  });

  it('allows inline styles while keeping inline scripts forbidden', async () => {
    const { headers, reply } = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    await hook(bareRequest(), reply as never, 'payload');
    const csp = headers.get('content-security-policy');
    expect(csp).toBeDefined();
    const directives = parseCsp(csp ?? '');
    expect(directives.get('connect-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directives.get('media-src')).toEqual(["'self'", 'blob:', 'data:', 'https:', 'http:']);
    const styleSrc = directives.get('style-src');
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
    const effectiveScriptSrc = directives.get('script-src') ?? directives.get('default-src');
    expect(effectiveScriptSrc).toBeDefined();
    expect(effectiveScriptSrc).not.toContain("'unsafe-inline'");
    expect(effectiveScriptSrc).not.toContain("'unsafe-eval'");
    expect(effectiveScriptSrc).not.toContain('data:');
  });

  it('allows website frames and blob workers only for the GUI policy', async () => {
    const gui = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    await hook({ routeOptions: { config: { webGui: true } } } as never, gui.reply as never, '');
    const directives = parseCsp(gui.headers.get('content-security-policy')!);
    expect(directives.get('frame-src')).toEqual(["'self'", 'http://*.kiki-document.localhost:*', 'https:', 'http:', 'blob:']);
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(directives.get('connect-src')).toEqual(["'self'", 'https:', 'http:', 'ws:', 'wss:', 'data:', 'blob:']);
    expect(directives.get('media-src')).toEqual(["'self'", 'blob:', 'data:', 'https:', 'http:']);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:', 'http:']);
    expect(directives.get('script-src') ?? directives.get('default-src')).toEqual(["'self'"]);

    const api = captureHeaders();
    await hook(bareRequest(), api.reply as never, '');
    const apiDirectives = parseCsp(api.headers.get('content-security-policy')!);
    expect(apiDirectives.get('frame-src')).toEqual(["'self'", 'http://*.kiki-document.localhost:*']);
    expect(apiDirectives.get('connect-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(apiDirectives.get('media-src')).toEqual(["'self'", 'blob:', 'data:', 'https:', 'http:']);
    expect(apiDirectives.has('worker-src')).toBe(false);
    expect(apiDirectives.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('keeps the Desktop script policy strict while allowing website frames and PDF workers', () => {
    const directives = parseCsp(KIKI_APP_CSP);
    expect(directives.get('frame-src')).toEqual(["'self'", 'kiki-app:', 'http://*.kiki-document.localhost:*', 'https:', 'http:', 'blob:']);
    expect(directives.get('worker-src')).toEqual(["'self'", 'kiki-app:', 'blob:']);
    expect(directives.get('connect-src')).toEqual(["'self'", 'kiki-app:', 'https:', 'http:', 'ws:', 'wss:', 'data:', 'blob:']);
    expect(directives.get('media-src')).toEqual(["'self'", 'kiki-app:', 'blob:', 'data:', 'https:', 'http:']);
    expect(directives.get('script-src')).toEqual(["'self'", 'kiki-app:']);
  });

  it('does not replace an isolated document policy even when the route also marks GUI assets', async () => {
    const { headers, reply } = captureHeaders();
    reply.header('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'");
    await createSecurityHeadersHook({ tls: false })({ routeOptions: { config: { webGui: true, htmlPreviewResource: true } } } as never, reply as never, '');
    expect(headers.get('content-security-policy')).toBe("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'");
  });

  it('emits HSTS only when TLS is terminated at the server', async () => {
    const plain = captureHeaders();
    await createSecurityHeadersHook({ tls: false })(bareRequest(), plain.reply as never, '');
    expect(plain.headers.has('strict-transport-security')).toBe(false);

    const tls = captureHeaders();
    await createSecurityHeadersHook({ tls: true })(bareRequest(), tls.reply as never, '');
    expect(tls.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
