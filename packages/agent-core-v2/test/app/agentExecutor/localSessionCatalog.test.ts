import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import type { IAgentExecutorRegistry, AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import { LocalSessionCatalog } from '#/app/agentExecutor/localSessionCatalog';
import { parseLocalSession } from '#/app/agentExecutor/localSessionParser';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

const jsonl = (...records: unknown[]) => records.map((value) => JSON.stringify(value)).join('\n') + '\n';
const time = '2026-09-29T12:00:00.000Z';
const claudeRecord = (id: string, content: unknown = 'hello', extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: id, cwd: '/work', timestamp: time, message: { content }, ...extra,
});
const codexHeader = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'session_meta', timestamp: time, payload: { id, cwd: '/work', ...extra },
});
function catalog(home: string, fs: IHostFileSystem = new HostFileSystem(), override?: Partial<AgentExecutorDescriptor>, negotiated?: { resume: boolean; load: boolean }) {
  const bootstrap = { osHomeDir: home, getEnv: () => undefined } as unknown as IBootstrapService;
  const registry = { get: (id: string) => ({ id, revision: '1', protocol: 'acp-v1', args: [],
    homeEnv: id === 'claude-acp' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', ...override }),
    lastNegotiated: () => negotiated } as unknown as IAgentExecutorRegistry;
  return new LocalSessionCatalog(bootstrap, fs, registry);
}
async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'local-session-catalog-'));
  try { await run(home); }
  finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function transcript(home: string, relative: string, content: string) {
  const path = join(home, relative);
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe('local vendor transcript parsing', () => {
  it('uses Claude rename precedence and excludes model bookkeeping without changing real messages', () => {
    const parsed = parseLocalSession('claude', jsonl(
      claudeRecord('claude-id', 'First user prompt'),
      claudeRecord('claude-id', '[Request interrupted by user]'),
      claudeRecord('claude-id', '[Request interrupted by user] quoted'),
      claudeRecord('claude-id', 'injected', { isMeta: true }),
      claudeRecord('claude-id', 'subagent', { isSidechain: true }),
      { type: 'assistant', timestamp: time, message: { model: '<synthetic>', content: 'placeholder' } },
      { type: 'assistant', timestamp: time, message: { content: [
        { type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Answer' },
        { type: 'tool_use', name: 'Read', input: { path: 'PRIVATE_INPUT' } },
      ] } },
      { type: 'ai-title', aiTitle: 'Generated title' },
      { type: 'custom-title', customTitle: 'User rename' },
      { type: 'ai-title', aiTitle: 'Later generated title' },
    ));
    expect(parsed).toMatchObject({ externalId: 'claude-id', title: 'User rename', cwd: '/work',
      lastPrompt: '[Request interrupted by user] quoted' });
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2]?.blocks).toEqual([
      { kind: 'thought', text: 'Reasoning' }, { kind: 'text', text: 'Answer' }, { kind: 'tool_call', name: 'Read' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_INPUT');
  });

  it('latches the first Codex header and pairs response/event twins one-to-one', () => {
    const parsed = parseLocalSession('codex', jsonl(
      codexHeader('child-id', { parent_thread_id: 'parent-id', history_base: {} }),
      codexHeader('parent-id', { cwd: '/parent' }),
      { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Repeat' }] } },
      { type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: 'Repeat' } },
      { type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: 'Repeat' } },
      { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
      { type: 'event_msg', timestamp: time, payload: { type: 'agent_message', message: 'Answer' } },
      { type: 'event_msg', timestamp: time, payload: { type: 'thread_name_updated', thread_name: 'Native title' } },
    ));
    expect(parsed).toMatchObject({ externalId: 'child-id', cwd: '/work', parentId: 'parent-id', title: 'Native title' });
    expect(parsed.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant']);
    expect(parsed.warnings).toContain('inherited_history_not_loaded');
  });

  it('keeps identical Codex prompts from different timestamped turns', () => {
    const parsed = parseLocalSession('codex', jsonl(
      codexHeader('id'),
      { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] } },
      { type: 'event_msg', timestamp: '2026-09-29T12:01:00Z', payload: { type: 'user_message', message: 'Again' } },
    ));
    expect(parsed.messages).toHaveLength(2);
  });

  it('shows response-only Codex transcripts and clips unsupported or oversized blocks visibly', () => {
    const parsed = parseLocalSession('codex', jsonl(
      codexHeader('id'),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'x'.repeat(40_000) }, { type: 'input_image', image_url: 'data:PRIVATE_MEDIA' },
        { type: 'future_type', data: 'PRIVATE_DATA' },
      ] } },
    ) + '{torn');
    expect(parsed.messages[0]?.blocks[0]?.text).toHaveLength(32_768);
    expect(parsed.messages[0]?.blocks[1]).toEqual({ kind: 'image' });
    expect(parsed.warnings).toEqual(expect.arrayContaining(['content_truncated', 'unsupported_content', 'invalid_jsonl_record']));
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_');
  });
});

describe('read-only local vendor catalog', () => {
  it('keeps the scanned source home paired with its source ID if executor configuration changes while reading', async () => {
    await fixture(async (home) => {
      await transcript(home, 'first/projects/project/thread.jsonl', jsonl(claudeRecord('thread')));
      await mkdir(join(home, 'second'));
      const fs = new HostFileSystem();
      const override = { homeDir: join(home, 'first') };
      const readBytes = fs.readBytes.bind(fs);
      vi.spyOn(fs, 'readBytes').mockImplementation(async (...args) => {
        override.homeDir = join(home, 'second');
        return readBytes(...args);
      });
      const service = catalog(home, fs, override);
      const summary = (await service.list('claude-acp')).items[0]!;
      expect(summary.sourceHome).toBe(await fs.realpath(join(home, 'first')));
      expect(await service.sourceHome('claude-acp')).toBe(await fs.realpath(join(home, 'second')));
    });
  });
  it('marks engines that negotiated neither resume nor load as browse-only', async () => {
    await fixture(async (home) => {
      await transcript(home, '.claude/projects/project/thread.jsonl', jsonl(claudeRecord('thread')));
      const unsupported = catalog(home, new HostFileSystem(), undefined, { resume: false, load: false });
      const source = (await unsupported.list('claude-acp')).items[0]!;
      expect(source.resume).toEqual({ supported: false, reason: 'engine_resume_unsupported' });
      expect((await unsupported.get('claude-acp', source.id))?.messages).toHaveLength(1);
      const supported = catalog(home, new HostFileSystem(), undefined, { resume: false, load: true });
      expect((await supported.list('claude-acp')).items[0]?.resume.supported).toBe(true);
    });
  });
  it('lists and reads Claude transcripts with disjoint source identities and no writes', async () => {
    await fixture(async (home) => {
      const content = jsonl(claudeRecord('shared-id'), { type: 'custom-title', customTitle: 'Named session' });
      const path = await transcript(home, '.claude/projects/project/shared-id.jsonl', content);
      await transcript(home, '.claude/projects/project/agent-child.jsonl', jsonl(claudeRecord('agent-child')));
      const fs = new HostFileSystem();
      const writer = vi.spyOn(fs, 'writeText');
      const service = catalog(home, fs);
      const listed = await service.list('claude-acp');
      expect(listed).toMatchObject({ exists: true, truncated: false, unreadableFiles: 0 });
      expect(listed.items).toHaveLength(1);
      const summary = listed.items[0]!;
      expect(summary.id).toMatch(/^external:claude:[a-f0-9]{64}$/);
      expect(summary.externalId).toBe('shared-id');
      const detail = await service.get('claude-acp', summary.id);
      expect(detail?.summary).toEqual(summary);
      expect(detail?.messages[0]?.blocks).toEqual([{ kind: 'text', text: 'hello' }]);
      expect(await readFile(path, 'utf8')).toBe(content);
      expect(writer).not.toHaveBeenCalled();
      expect(await readdir(home)).toEqual(['.claude']);
    });
  });

  it('collapses immutable Codex reverts by filename recency and keeps the same source ID across ACP/app-server', async () => {
    await fixture(async (home) => {
      await transcript(home, '.codex/sessions/2026/09/29/rollout-2026-09-29T12-00-00-shared-id.jsonl',
        jsonl(codexHeader('shared-id'), { type: 'event_msg', payload: { type: 'user_message', message: 'Old' } }));
      await transcript(home, '.codex/sessions/2026/09/29/rollout-2026-09-29T13-00-00-shared-id_new-rollout.jsonl',
        jsonl(codexHeader('shared-id'), { type: 'event_msg', payload: { type: 'user_message', message: 'New' } }));
      const service = catalog(home);
      const listed = await service.list('codex-app-server');
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.lastPrompt).toBe('New');
      expect((await service.list('codex-acp')).items[0]?.id).toBe(listed.items[0]?.id);
      const detail = await service.get('codex-app-server', listed.items[0]!.id);
      expect(detail?.messages[0]?.blocks[0]?.text).toBe('New');
    });
  });

  it('bounds directory results and reports omitted sessions explicitly', async () => {
    await fixture(async (home) => {
      await transcript(home, '.claude/projects/project/first.jsonl', jsonl(claudeRecord('first')));
      await transcript(home, '.claude/projects/project/second.jsonl', jsonl(claudeRecord('second')));
      const service = catalog(home);
      expect(await service.list('claude-acp', 1)).toMatchObject({ truncated: true, unreadableFiles: 0 });
      expect((await service.list('claude-acp', 1)).items).toHaveLength(1);
      await expect(service.list('claude-acp', 201)).rejects.toThrow(/between 1 and 200/);
    });
  });

  it('honors executor home overrides and reports missing roots instead of creating them', async () => {
    await fixture(async (home) => {
      const custom = join(home, 'custom-claude');
      await transcript(home, 'custom-claude/projects/project/id.jsonl', jsonl(claudeRecord('id')));
      const service = catalog(home, undefined, { homeDir: custom });
      expect((await service.list('claude-acp')).items).toHaveLength(1);
      expect(await catalog(home).list('claude-acp')).toMatchObject({ exists: false, items: [] });
      expect(await readdir(home)).toEqual(['custom-claude']);
    });
  });

  it('rejects foreign IDs and path-shaped IDs before reading files', async () => {
    const fs = new HostFileSystem();
    const read = vi.spyOn(fs, 'readBytes');
    const scan = vi.spyOn(fs, 'readdir');
    const service = catalog('/unused', fs);
    expect(await service.get('claude-acp', '../../auth.json')).toBeUndefined();
    expect(await service.get('claude-acp', `external:codex:${'a'.repeat(64)}`)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    await expect(service.list('native')).rejects.toThrow(/no supported local session catalog/);
  });

  it('skips symlink entries and entries whose canonical path escapes the transcript root', async () => {
    await fixture(async (home) => {
      const path = await transcript(home, '.claude/projects/project/id.jsonl', jsonl(claudeRecord('id')));
      const fs = new HostFileSystem();
      const reads = vi.spyOn(fs, 'readBytes');
      const entries = fs.readdir.bind(fs);
      const listing = vi.spyOn(fs, 'readdir').mockImplementation(async (value) =>
        (await entries(value)).map((entry) => entry.name === 'id.jsonl' ? { ...entry, isSymbolicLink: true } : entry));
      expect((await catalog(home, fs).list('claude-acp')).items).toEqual([]);
      listing.mockRestore();
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation(async (value) => value === path ? '/outside/auth.json' : realpath(value));
      expect((await catalog(home, fs).list('claude-acp')).items).toEqual([]);
      expect(reads).not.toHaveBeenCalled();
    });
  });

  it('tolerates a vendor transcript disappearing during the directory scan', async () => {
    await fixture(async (home) => {
      const gone = await transcript(home, '.claude/projects/project/gone.jsonl', jsonl(claudeRecord('gone')));
      await transcript(home, '.claude/projects/project/kept.jsonl', jsonl(claudeRecord('kept')));
      const fs = new HostFileSystem();
      const canonicalGone = await fs.realpath(gone);
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, 'stat').mockImplementation(async (path) => {
        if (path === canonicalGone) throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'Removed by vendor');
        return stat(path);
      });
      expect((await catalog(home, fs).list('claude-acp')).items.map((item) => item.externalId)).toEqual(['kept']);
    });
  });

  it('marks sampled long transcripts and preserves both opening metadata and recent messages', async () => {
    await fixture(async (home) => {
      const content = jsonl(claudeRecord('long-id', 'First prompt')) +
        jsonl({ type: 'progress', payload: 'x'.repeat(300_000) }) +
        jsonl(claudeRecord('long-id', 'Most recent prompt'));
      await transcript(home, '.claude/projects/project/long-id.jsonl', content);
      const service = catalog(home);
      const listed = await service.list('claude-acp');
      expect(listed.items[0]).toMatchObject({ externalId: 'long-id', title: 'First prompt',
        lastPrompt: 'Most recent prompt', partial: true });
      const detail = await service.get('claude-acp', listed.items[0]!.id);
      expect(detail?.summary.partial).toBe(false);
      expect(detail?.messages).toHaveLength(2);
    });
  });
});
