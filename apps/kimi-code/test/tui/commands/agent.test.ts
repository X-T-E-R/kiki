import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  handleAgentCommand,
  loadSelectableAgentProfiles,
  type SelectableAgentProfile,
} from '#/tui/commands/agent';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const PROFILES: readonly SelectableAgentProfile[] = [
  { name: 'agent', description: 'Default profile', main: false },
  { name: 'grok-only', description: 'Pinned main profile', main: true },
];

function makeHost(agentProfile?: string) {
  const appState = { agentProfile };
  const host = {
    state: { appState },
    setAppState: vi.fn((patch: Partial<typeof appState>) => Object.assign(appState, patch)),
    showNotice: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, appState };
}

const loadProfiles = vi.fn(async () => PROFILES);

describe('/agent', () => {
  it('lists catalog profiles, marks main profiles, and shows the current binding', async () => {
    const { host } = makeHost('grok-only');

    await handleAgentCommand(host, '', loadProfiles);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Agent profiles',
      expect.stringContaining('Current for new sessions: grok-only'),
    );
    const detail = vi.mocked(host.showNotice).mock.calls[0]?.[1] ?? '';
    expect(detail).toContain('* grok-only (main) — Pinned main profile');
    expect(detail).toContain('  agent — Default profile');
  });

  it('changes only the profile used for future sessions', async () => {
    const { host, appState } = makeHost('agent');

    await handleAgentCommand(host, 'grok-only', loadProfiles);

    expect(appState.agentProfile).toBe('grok-only');
    expect(host.showNotice).toHaveBeenCalledWith(
      'Agent profile for new sessions: grok-only',
      'The current session is unchanged. Run /new to start a session with this profile.',
    );
  });

  it('rejects names outside the catalog without changing the binding', async () => {
    const { host, appState } = makeHost('agent');

    await handleAgentCommand(host, 'missing', loadProfiles);

    expect(appState.agentProfile).toBe('agent');
    expect(host.showError).toHaveBeenCalledWith('Unknown agent profile: missing');
  });

  it('loads project profiles with main true from the v2 catalog grammar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-command-'));
    try {
      await mkdir(join(dir, '.git'));
      const agentDir = join(dir, '.kiki', 'agents');
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'grok-only.md'),
        [
          '---',
          'name: grok-only',
          'description: Pinned main profile',
          'main: true',
          '---',
          'Use the pinned model.',
        ].join('\n'),
      );
      await writeFile(
        join(agentDir, 'm3-worker.md'),
        '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\nPrivate prompt.',
      );
      const configPath = join(dir, 'config.toml');
      await writeFile(configPath, '');

      const profiles = await loadSelectableAgentProfiles({
        harness: { homeDir: join(dir, 'home'), configPath },
        state: { appState: { workDir: dir } },
      } as Pick<SlashCommandHost, 'harness' | 'state'>);

      expect(profiles).toContainEqual({
        name: 'grok-only',
        description: 'Pinned main profile',
        main: true,
      });
      expect(profiles.some((profile) => profile.name === 'm3-worker')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('allows a same-name project profile without override when the builtin is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-command-disabled-builtin-'));
    try {
      await mkdir(join(dir, '.git'));
      const agentDir = join(dir, '.kiki', 'agents');
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'agent.md'),
        [
          '---',
          'name: agent',
          'description: Project replacement',
          '---',
          'Use the project profile.',
        ].join('\n'),
      );
      const configPath = join(dir, 'config.toml');
      await writeFile(configPath, 'disabled_builtin_profiles = ["agent"]\n');

      const profiles = await loadSelectableAgentProfiles({
        harness: { homeDir: join(dir, 'home'), configPath },
        state: { appState: { workDir: dir } },
      } as Pick<SlashCommandHost, 'harness' | 'state'>);
      expect(profiles).toContainEqual({
        name: 'agent',
        description: 'Project replacement',
        main: false,
      });

      const { host, appState } = makeHost('grok-only');
      const load = async () => profiles;
      await handleAgentCommand(host, '', load);
      expect(vi.mocked(host.showNotice).mock.calls[0]?.[1]).toContain(
        '  agent — Project replacement',
      );

      await handleAgentCommand(host, 'agent', load);
      expect(appState.agentProfile).toBe('agent');
      expect(host.showError).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
