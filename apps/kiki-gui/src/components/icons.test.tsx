// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProfileIcon } from '../lib/profileIcon';
import { Icon, OutcomeMark, resolvePluginSlotIconName, type IconName, type OutcomeState } from './icons';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(node); });
  return container;
}

const LABELS = { running: 'Running', failed: 'Failed', stopped: 'Stopped', done: 'Done' };

describe('icon family', () => {
  it('draws standard icons via lucide-react and custom marks to the 16px spec', async () => {
    const container = await render(<Icon name="read" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('data-icon')).toBe('read');
    expect(svg?.getAttribute('class')).toContain('h-3.5 w-3.5');

    const partial = await render(<Icon name="partial" />);
    const partialSvg = partial.querySelector('svg');
    expect(partialSvg?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(partialSvg?.getAttribute('stroke-width')).toBe('1.35');
    expect(partialSvg?.getAttribute('data-icon')).toBe('partial');
  });

  it('maps the three family sizes and lets an explicit box override them', async () => {
    const small = await render(<Icon name="chevron" size={12} />);
    expect(small.querySelector('svg')?.getAttribute('class')).toContain('h-3 w-3');
    const nav = await render(<Icon name="menu" size={16} />);
    expect(nav.querySelector('svg')?.getAttribute('class')).toContain('h-4 w-4');
    const custom = await render(<Icon name="menu" size={16} className="h-5 w-5" />);
    expect(custom.querySelector('svg')?.getAttribute('class')).not.toContain('h-4');
  });

  it('draws smartphone and plugin icons cleanly and maps plugin slot icon hints', async () => {
    const phone = await render(<Icon name="smartphone" size={16} />);
    expect(phone.querySelector('svg')?.getAttribute('data-icon')).toBe('smartphone');
    const plugin = await render(<Icon name="plugin" size={16} />);
    expect(plugin.querySelector('svg')?.getAttribute('data-icon')).toBe('plugin');

    expect(resolvePluginSlotIconName({ icon: 'phone', pluginId: 'other' })).toBe('smartphone');
    expect(resolvePluginSlotIconName({ icon: 'smartphone', pluginId: 'other' })).toBe('smartphone');
    expect(resolvePluginSlotIconName({ pluginId: 'kiki-phone', panelId: 'preview' })).toBe('smartphone');
    expect(resolvePluginSlotIconName({ icon: 'terminal', pluginId: 'cordis-sh' })).toBe('terminal');
    expect(resolvePluginSlotIconName({ pluginId: 'cordis-notes', fallback: 'star' })).toBe('star');
  });

  it('draws semantic monochrome profile icons and resolves built-in, custom, file, and external profiles', async () => {
    const profileGlyphs: readonly IconName[] = [
      'profileMain',
      'profileCode',
      'profileFrontend',
      'profileResearch',
      'profileReview',
      'profileThink',
      'profileOperator',
      'profileWorker',
      'profileWriter',
      'profileDirector',
    ];
    for (const glyph of profileGlyphs) {
      const container = await render(<Icon name={glyph} size={14} />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(svg?.getAttribute('stroke-width')).toBe('1.35');
      expect(svg?.getAttribute('data-icon')).toBe(glyph);
      expect(svg?.children.length).toBeGreaterThan(0);
      expect(svg?.querySelector('text')).toBeNull();
    }

    expect(resolveProfileIcon({ main: true })).toBe('profileMain');
    expect(resolveProfileIcon({ profile: 'agent', main: true })).toBe('profileMain');
    expect(resolveProfileIcon({ profile: 'explore' })).toBe('compass');
    expect(resolveProfileIcon({ profile: 'implementer' })).toBe('profileCode');
    expect(resolveProfileIcon({ profile: 'implementer-grokbuild', executor: 'grok' })).toBe('profileCode');
    expect(resolveProfileIcon({ profile: 'frontend' })).toBe('profileFrontend');
    expect(resolveProfileIcon({ profile: 'researcher' })).toBe('profileResearch');
    expect(resolveProfileIcon({ profile: 'reviewer' })).toBe('profileReview');
    expect(resolveProfileIcon({ profile: 'think' })).toBe('profileThink');
    expect(resolveProfileIcon({ profile: 'operator' })).toBe('profileOperator');
    expect(resolveProfileIcon({ profile: 'worker' })).toBe('profileWorker');
    expect(resolveProfileIcon({ profile: 'writer' })).toBe('profileWriter');
    expect(resolveProfileIcon({ profile: 'director', main: true })).toBe('profileDirector');
    expect(resolveProfileIcon({ executor: 'codex-cli' })).toBe('terminal');
    expect(resolveProfileIcon({ hasFile: true })).toBe('file');
    expect(resolveProfileIcon({ profile: 'custom-helper', description: 'Independent security audit and code review' })).toBe('profileReview');
  });
});

describe('OutcomeMark', () => {
  it('keeps success visually silent but still announced', async () => {
    const container = await render(<OutcomeMark state="done" labels={LABELS} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.sr-only')?.textContent).toBe('Done');
  });

  it.each<[OutcomeState, string]>([
    ['running', 'Running'],
    ['failed', 'Failed'],
    ['stopped', 'Stopped'],
  ])('marks %s with a labelled drawn mark', async (state, label) => {
    const container = await render(<OutcomeMark state={state} labels={LABELS} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });
});
