// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { hookSupport, kikiGroupTools } from '../../harness/kikiContext';
import { KikiContextField } from './KikiContextField';
import { draftFromProfile, type ProfileDraft } from './profileDraft';

const lead: NamedAgentProfile = {
  name: 'lead', description: 'Lead', main: true, executor: 'claude-acp', source: 'user',
  source_file: '/fixture/lead.md', workspace_id: 'ws-one', disabled: false, routes: [],
};

describe('hook support per engine', () => {
  it('marks Claude and Codex supported, with PreCompact only preparing', () => {
    for (const id of ['claude-acp', 'codex-acp', 'codex-app-server']) {
      const support = hookSupport(id);
      expect(support.level).toBe('supported');
      expect(support.moments.map((moment) => [moment.event, moment.effect])).toEqual([
        ['SessionStart', 'inject'], ['UserPromptSubmit', 'inject'], ['PreCompact', 'prepare'],
      ]);
    }
  });

  it('marks Grok ACP supported on Stop, Antigravity untested, and others unsupported', () => {
    expect(hookSupport('grok-acp')).toMatchObject({ level: 'supported', moments: [{ event: 'Stop', effect: 'inject' }] });
    expect(hookSupport('antigravity-acp')).toMatchObject({ level: 'untested', moments: [{ event: 'PreInvocation' }] });
    expect(hookSupport('gemini-acp')).toEqual({ level: 'unsupported', moments: [] });
    expect(hookSupport('cursor-acp').level).toBe('unsupported');
  });

  it('lists the eleven bridge tools across the five groups', () => {
    const counts = (['memory', 'board', 'cron', 'threads', 'history'] as const).map((group) => kikiGroupTools(group).length);
    expect(counts).toEqual([3, 2, 1, 3, 2]);
    expect(kikiGroupTools('hooks')).toEqual([]);
  });
});

describe('KikiContextField', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    localStorage.setItem('kiki.locale', 'en');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(profile: NamedAgentProfile, onChange = vi.fn<(next: Pick<ProfileDraft, 'allowKikiSubagents' | 'kikiContext'>) => void>()) {
    const draft = draftFromProfile(profile);
    await act(async () => root.render(<I18nProvider>
      <KikiContextField draft={draft} baseline={draft} engine="Engine" disabled={false} onChange={onChange} />
    </I18nProvider>));
    return onChange;
  }
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-kiki-capability="${id}"]`)!;
  const toggle = async (id: string) => { await act(async () => { row(id).querySelector('input')!.click(); }); };

  it('lists delegation, the five tool groups and hooks, all off for an absent field', async () => {
    await render(lead);
    expect([...container.querySelectorAll<HTMLElement>('[data-kiki-capability]')].map((node) => node.dataset['kikiCapability']))
      .toEqual(['subagents', 'memory', 'board', 'cron', 'threads', 'history', 'hooks']);
    expect(container.querySelectorAll('[data-kiki-capability][data-on="true"]')).toHaveLength(0);
    expect(row('memory').textContent).toContain('kiki_memory_write');
    expect(container.querySelector<HTMLElement>('[data-kiki-context-field]')?.dataset['kikiContextField']).toBe('absent');
    expect(container.querySelector<HTMLElement>('[data-kiki-context-clear]')).toBeNull();
  });

  it('tells an explicit [] apart from an absent field and offers to remove it', async () => {
    const onChange = await render({ ...lead, kiki_context: [] });
    expect(container.querySelector<HTMLElement>('[data-kiki-context-field]')?.dataset['kikiContextField']).toBe('empty');
    expect(container.textContent).toContain('explicitly all off');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-kiki-context-clear]')!.click(); });
    expect(onChange).toHaveBeenLastCalledWith({ allowKikiSubagents: false, kikiContext: undefined });
  });

  it('turns a group on into the list and keeps delegation on its own flag', async () => {
    const onChange = await render({ ...lead, allow_kiki_subagents: true, kiki_context: ['hooks'] });
    expect(row('subagents').dataset['on']).toBe('true');
    await toggle('board');
    expect(onChange).toHaveBeenLastCalledWith({ allowKikiSubagents: true, kikiContext: ['board', 'hooks'] });
    await toggle('subagents');
    expect(onChange).toHaveBeenLastCalledWith({ allowKikiSubagents: false, kikiContext: ['hooks'] });
  });

  it('shows hook support for the current engine, PreCompact as prepare-only', async () => {
    await render(lead);
    expect(container.querySelector<HTMLElement>('[data-hook-support]')?.dataset['hookSupport']).toBe('supported');
    const preCompact = container.querySelector<HTMLElement>('[data-hook-moment="PreCompact"]')!;
    expect(preCompact.dataset['hookEffect']).toBe('prepare');
    expect(preCompact.textContent).toContain('injects nothing');
    expect(row('hooks').querySelector('input')!.disabled).toBe(false);
  });

  it('marks Antigravity untested and disables hooks on an engine without them', async () => {
    await render({ ...lead, executor: 'antigravity-acp' });
    expect(container.querySelector<HTMLElement>('[data-hook-support]')?.textContent).toContain('untested');
    expect(row('hooks').querySelector('input')!.disabled).toBe(false);
    await render({ ...lead, executor: 'gemini-acp' });
    expect(container.querySelector<HTMLElement>('[data-hook-support]')?.dataset['hookSupport']).toBe('unsupported');
    expect(container.querySelector<HTMLElement>('[data-hook-moments]')).toBeNull();
    expect(row('hooks').querySelector('input')!.disabled).toBe(true);
  });

  it('keeps a written hooks entry switchable off on an unsupported engine', async () => {
    const onChange = await render({ ...lead, executor: 'gemini-acp', kiki_context: ['hooks'] });
    expect(row('hooks').querySelector('input')!.disabled).toBe(false);
    await toggle('hooks');
    expect(onChange).toHaveBeenLastCalledWith({ allowKikiSubagents: false, kikiContext: [] });
  });
});
