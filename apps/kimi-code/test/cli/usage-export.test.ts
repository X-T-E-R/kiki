import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerUsageExportCommand } from '../../src/kiki/usage-export';

const mocks = vi.hoisted(() => ({ saveDraft: vi.fn(), status: vi.fn(), syncNow: vi.fn(), close: vi.fn(), ensureServer: vi.fn() }));
vi.mock('../../src/kiki/serve', () => ({ ensureServer: mocks.ensureServer }));
vi.mock('@kiki/klient/http', () => ({ createKlient: () => ({ rest: { usageExport: mocks }, close: mocks.close }) }));
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'vbu_SYNTHETIC_CONFIG_KEY';
const dirs: string[] = [];
let output: string;
beforeEach(() => {
  vi.clearAllMocks(); output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  mocks.ensureServer.mockResolvedValue({ url: 'http://127.0.0.1:12345', token: 'fixture-only' });
  mocks.saveDraft.mockImplementation(async (input) => ({ ...input.draft, id: input.draft.id ?? ID, enabled: input.auto_upload === true, state: input.auto_upload ? 'ready' : 'draft', credential_storage: 'keyring' }));
});
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function config(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'kiki-export-cli-')); dirs.push(dir);
  const file = join(dir, 'config.json'); await writeFile(file, JSON.stringify(value)); return file;
}
async function run(args: string[]) {
  const program = new Command().exitOverride(); program.configureOutput({ writeErr: () => {} });
  registerUsageExportCommand(program);
  await program.parseAsync(['node', 'kiki', 'usage-export', ...args]);
}

describe('usage-export connect-vibe', () => {
  it('imports only the specified config in memory, consents once and prints no key', async () => {
    const file = await config({ apiUrl: 'https://vibecafe.ai', apiKey: KEY, unrelated: 'not exported' });
    await run(['connect-vibe', '--config', file, '--agree']);
    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    const input = mocks.saveDraft.mock.calls[0]![0];
    expect(input).toMatchObject({ auto_upload: true, draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: 'https://vibecafe.ai/api/usage/ingest' }, schedule_minutes: 120, scope: { end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } }, secret: { value: KEY, storage: 'auto' } });
    expect(input.draft.scope.start_at % 1_800_000).toBe(0);
    expect(output).not.toContain(KEY); expect(output).not.toContain('secret');
    expect(JSON.parse(output)).toMatchObject({ id: ID, enabled: true, schedule_minutes: 120 });
    expect(mocks.syncNow).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('preserves an existing destination scope and allows an explicit UTC start', async () => {
    const file = await config({ apiUrl: 'https://receiver.example.test/', apiKey: KEY });
    const scope = { start_at: 1_800_000, end_at: null, include_ephemeral: true, excluded_workspace_ids: ['example-workspace'] };
    mocks.status.mockResolvedValue({ destinations: [{ destination: { id: ID, label: 'Existing', target: { kind: 'vibe' }, scope } }] });
    await run(['connect-vibe', '--config', file, '--agree', '--id', ID]);
    expect(mocks.saveDraft.mock.calls[0]![0].draft).toMatchObject({ id: ID, label: 'Existing', scope, target: { endpoint: 'https://receiver.example.test/api/usage/ingest' } });
    await run(['connect-vibe', '--config', file, '--agree', '--id', ID, '--start-at', '2026-01-01T00:00:00Z']);
    expect(mocks.saveDraft.mock.calls[1]![0].draft.scope).toEqual({ ...scope, start_at: Date.UTC(2026, 0, 1) });
  });

  it.each([
    { apiUrl: 'http://receiver.example.test', apiKey: KEY },
    { apiUrl: `https://${KEY}@receiver.example.test`, apiKey: KEY },
    { apiUrl: 'https://receiver.example.test/private', apiKey: KEY },
    { apiUrl: 'https://receiver.example.test', apiKey: `${KEY}\ninvalid` },
  ])('rejects invalid configuration without printing it', async (value) => {
    const file = await config(value);
    let error: unknown; try { await run(['connect-vibe', '--config', file, '--agree']); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(KEY); expect(output).not.toContain(KEY);
    expect(mocks.saveDraft).not.toHaveBeenCalled(); expect(mocks.ensureServer).not.toHaveBeenCalled();
  });

  it('requires explicit agreement and a half-hour UTC boundary before reading or saving a destination', async () => {
    await expect(run(['connect-vibe', '--config', 'missing-fixture.json'])).rejects.toThrow('--agree');
    const file = await config({ apiUrl: 'https://vibecafe.ai', apiKey: KEY });
    await expect(run(['connect-vibe', '--config', file, '--agree', '--start-at', '2026-01-01T00:01:00Z'])).rejects.toThrow('UTC half-hour');
    expect(mocks.ensureServer).not.toHaveBeenCalled(); expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it('retains save --input draft-only behavior', async () => {
    const input = { draft: { label: 'Manual', target: { kind: 'vibe', endpoint: 'https://vibecafe.ai/api/usage/ingest' }, scope: { start_at: 0, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] }, schedule_minutes: 0 } };
    const file = await config(input); await run(['save', '--input', file]);
    expect(mocks.saveDraft).toHaveBeenCalledWith(input); expect(JSON.parse(output).enabled).toBe(false);
  });
});
