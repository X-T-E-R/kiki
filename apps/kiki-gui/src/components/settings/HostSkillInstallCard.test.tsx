// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/client';
import { HostSkillInstallCard } from './HostSkillInstallCard';

const preview = (overwrites: boolean, revision = 'rev-1') => ({
  host: 'claude',
  directory: '/home/example/.claude/skills',
  path: '/home/example/.claude/skills/kiki-as-subagent/SKILL.md',
  overwrites,
  revision,
});

const previewHostSkillInstall = vi.fn();
const installHostSkill = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { previewHostSkillInstall, installHostSkill } }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  previewHostSkillInstall.mockReset();
  installHostSkill.mockReset();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => { element!.click(); });
  await flush();
}

async function render(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<I18nProvider><HostSkillInstallCard /></I18nProvider>); });
}

describe('HostSkillInstallCard', () => {
  it('offers one install entry per host and writes nothing until confirmed', async () => {
    previewHostSkillInstall.mockResolvedValue(preview(false));
    await render();
    const hosts = [...document.querySelectorAll('[data-host-skill-preview]')].map((node) => node.getAttribute('data-host-skill-preview'));
    expect(hosts).toEqual(['claude', 'codex', 'grok', 'agents']);

    await click('[data-host-skill-preview="claude"]');
    expect(previewHostSkillInstall).toHaveBeenCalledWith('claude');
    expect(installHostSkill).not.toHaveBeenCalled();
    expect(document.querySelector('[data-host-skill-path]')?.textContent).toBe(preview(false).path);
    expect(document.querySelector('[data-host-skill-overwrites]')?.getAttribute('data-host-skill-overwrites')).toBe('false');
    expect(document.querySelector('[data-host-skill-confirm]')?.textContent).toBe('Install skill');

    installHostSkill.mockResolvedValue(preview(false));
    await click('[data-host-skill-confirm]');
    expect(installHostSkill).toHaveBeenCalledWith('claude', 'rev-1');
    expect(document.querySelector('[data-host-skill-dialog]')).toBeNull();
    expect(document.querySelector('[data-host-skill-installed="claude"]')?.textContent).toContain('kiki-as-subagent/SKILL.md');
  });

  it('names an overwrite before the user confirms it', async () => {
    previewHostSkillInstall.mockResolvedValue(preview(true));
    await render();
    await click('[data-host-skill-preview="codex"]');
    expect(document.querySelector('[data-host-skill-overwrites]')?.getAttribute('data-host-skill-overwrites')).toBe('true');
    expect(document.querySelector('[data-host-skill-confirm]')?.textContent).toBe('Replace skill');
  });

  it('asks for a new preview when the target changed (40001) and installs the new revision', async () => {
    previewHostSkillInstall.mockResolvedValueOnce(preview(false, 'rev-1')).mockResolvedValueOnce(preview(true, 'rev-2'));
    installHostSkill
      .mockRejectedValueOnce(new ApiError({ code: 40001, msg: 'Skill target changed; preview again before installing.', data: null }))
      .mockResolvedValueOnce(preview(true, 'rev-2'));
    await render();
    await click('[data-host-skill-preview="grok"]');
    await click('[data-host-skill-confirm]');
    expect(document.querySelector('[data-host-skill-error]')?.getAttribute('data-host-skill-error')).toBe('stale');
    expect(document.querySelector('[data-host-skill-confirm]')).toBeNull();

    await click('[data-host-skill-repreview]');
    expect(previewHostSkillInstall).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-host-skill-overwrites]')?.getAttribute('data-host-skill-overwrites')).toBe('true');
    await click('[data-host-skill-confirm]');
    expect(installHostSkill).toHaveBeenLastCalledWith('grok', 'rev-2');
  });
});
