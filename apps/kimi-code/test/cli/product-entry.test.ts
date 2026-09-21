import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/commands';

describe('unified Kiki entry', () => {
  it('installs only kiki and does not run legacy executable takeover hooks', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('@kiki/cli');
    expect(manifest.bin).toEqual({ kiki: 'dist/main.mjs' });
    expect(manifest.scripts.postinstall).toBeUndefined();
    expect(manifest.files).not.toContain('scripts/postinstall.mjs');
    expect(manifest.files).not.toContain('scripts/postinstall');
  });
  it('exposes daemon controls and interactive/noninteractive options in one command tree', async () => {
    const onMain = vi.fn();
    const program = createProgram('0.0.0-test', onMain);
    expect(program.name()).toBe('kiki');
    expect(program.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['serve', 'seat', 'mcp', 'doctor']));
    await program.parseAsync(['node', 'kiki']);
    expect(onMain).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: undefined }));
    const prompt = vi.fn();
    await createProgram('0.0.0-test', prompt).parseAsync(['node', 'kiki', '-p', 'Synthetic prompt; do not execute']);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Synthetic prompt; do not execute' }));
  });
});
