import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/commands';

describe('unified Kiki entry', () => {
  it('migrates projects explicitly and reports unknown assets without marking completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-entry-project-'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      await mkdir(join(root, '.kimi-code'));
      await writeFile(join(root, '.kimi-code', 'local.toml'), '[workspace]\nadditional_dir = []\n');
      await writeFile(join(root, '.kimi-code', 'custom-resource'), 'Synthetic resource');
      const program = createProgram('0.0.0-test', vi.fn());
      await program.parseAsync(['node', 'kiki', 'migrate-config', '--workspace', root, '--json']);
      expect(process.exitCode).toBe(2);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status":"incomplete"'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('custom-resource'));
      expect(await readFile(join(root, '.kiki', 'local.toml'), 'utf8')).toContain('additional_dir = []');
      await expect(readFile(join(root, '.kiki', '.kiki-config-migration-v2.json'))).rejects.toThrow();
      await expect(createProgram('0.0.0-test', vi.fn()).parseAsync(['node', 'kiki', 'migrate-config', '--workspace', root, '--home', root])).rejects.toThrow('--workspace cannot be combined');
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore(); stderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
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
    expect(program.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['serve', 'seat', 'mcp', 'doctor', 'migrate-config']));
    await program.parseAsync(['node', 'kiki']);
    expect(onMain).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: undefined }));
    const prompt = vi.fn();
    await createProgram('0.0.0-test', prompt).parseAsync(['node', 'kiki', '-p', 'Synthetic prompt; do not execute']);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Synthetic prompt; do not execute' }));
  });
  it('runs explicit configuration migration without dispatching a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-entry-migrate-'));
    const from = join(root, 'old'); const home = join(root, 'new');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await mkdir(from); await writeFile(join(from, 'config.toml'), 'model = "example"');
      const onMain = vi.fn();
      await createProgram('0.0.0-test', onMain).parseAsync(['node', 'kiki', 'migrate-config', '--from', from, '--home', home, '--json']);
      expect(onMain).not.toHaveBeenCalled();
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('model = "example"');
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status":"completed"'));
    } finally { stdout.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
