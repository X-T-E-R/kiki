import { describe, expect, it } from 'vitest';

import { wechatQrImage } from './wechatQr';

describe('wechatQrImage', () => {
  it('renders a crisp SVG data URL with the expected palette and margin', () => {
    const uri = wechatQrImage('https://example.test/pair');
    expect(uri).toBeDefined();
    expect(uri!.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(uri!.slice('data:image/svg+xml;charset=utf-8,'.length));
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#fbfaf6"');
    expect(svg).toContain('fill="#1b1a17"');
    expect(svg).toContain('<path ');
  });

  it('returns undefined for empty or unencodable input', () => {
    expect(wechatQrImage('')).toBeUndefined();
    expect(wechatQrImage('x'.repeat(10_000))).toBeUndefined();
  });
});
