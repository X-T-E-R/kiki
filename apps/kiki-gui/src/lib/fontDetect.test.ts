// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanFontName, detectFont, firstFamily, fontStack } from './fontDetect';

/** A canvas that draws an installed family at its own width and anything else in the generic after it. */
function stubCanvas(installed: readonly string[]) {
  let font = '';
  const context = {
    set font(value: string) { font = value; },
    get font() { return font; },
    measureText: () => {
      const families = font.replace(/^\d+px\s+/, '').split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
      const drawn = families.find((family) => installed.includes(family)) ?? families.at(-1)!;
      return { width: installed.includes(drawn) ? 101 : drawn.length };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fontDetect', () => {
  it('tells an installed family from one the browser falls back for', () => {
    stubCanvas(['Fixture Sans']);
    expect(detectFont('Fixture Sans')).toBe('present');
    expect(detectFont('Nowhere Grotesk')).toBe('missing');
    expect(detectFont('   ')).toBe('unknown');
  });

  it('keeps typed names to characters a stack can carry, and leads the stack with them', () => {
    expect(cleanFontName("Evil'; } body { x")).toBe('Evil  body  x'.replace(/\s+/g, ' '));
    expect(cleanFontName('霞鹜文楷')).toBe('霞鹜文楷');
    expect(fontStack('Fira Code ', 'monospace')).toBe("'Fira Code', monospace");
    expect(firstFamily("'Fira Code', monospace")).toBe('Fira Code');
  });
});
