// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCompiledGuiStylesheet } from './compiledGuiStylesheet';

const roots: string[] = [];

function fakeRepo(layout: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kiki-stylesheet-'));
  roots.push(root);
  for (const file of layout) {
    const full = join(root, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveCompiledGuiStylesheet', () => {
  it('finds the hashed index stylesheet in the app build', () => {
    const root = fakeRepo(['apps/kiki-gui/dist/assets/index-abc123.css', 'apps/kiki-gui/dist/assets/index-def456.js']);
    const found = resolveCompiledGuiStylesheet(root);
    expect(found.dir).toBe(join(root, 'apps', 'kiki-gui', 'dist', 'assets'));
    expect(found.cssPath).toBe(join(found.dir, 'index-abc123.css'));
  });

  it('fails when the GUI was never built', () => {
    const root = fakeRepo([]);
    expect(() => resolveCompiledGuiStylesheet(root)).toThrow(/compiled gui stylesheet is missing/);
  });

  it('fails when the assets directory exists but holds no compiled stylesheet', () => {
    const root = fakeRepo(['apps/kiki-gui/dist/assets/index-abc123.js']);
    expect(() => resolveCompiledGuiStylesheet(root)).toThrow(/no compiled stylesheet/);
  });
});
