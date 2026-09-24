// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDescriptor } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { MediaPreviewProvider } from '../mediaPreview';
import { AgentDetailDrawer } from '../agent-panel/AgentDetailDrawer';
import { SkillCard } from './rows';

const client = vi.hoisted(() => ({
  readHostFile: vi.fn<(path: string) => Promise<string>>(),
  readBuiltinSkill: vi.fn<(name: string) => Promise<string>>(),
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const sampleSkill: SkillDescriptor = {
  name: 'code-review',
  description: '代码审查规则集，自动化排查静态隐患。',
  path: 'C:/project/.agents/skills/code-review/SKILL.md',
  source: 'project',
  type: 'workflow',
  disable_model_invocation: true,
  prompt_command: true,
  argument_hint: '--strict',
};

beforeEach(() => {
  client.readHostFile.mockReset();
  client.readBuiltinSkill.mockReset();
  localStorage.setItem('kiki.locale', 'zh');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderSkill(skill: SkillDescriptor) {
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <MediaPreviewProvider>
            <SkillCard skill={skill} sourceLabel={skill.source === 'builtin' ? '内置' : '工作区'} />
          </MediaPreviewProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  });
}

async function viewSkill() {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('查看 SKILL.md'));
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}

describe('SkillCard preview', () => {
  it('opens a file skill at its real path in the preview tab', async () => {
    client.readHostFile.mockResolvedValue('# Code Review Instructions\n\nRun review checks.');
    await renderSkill(sampleSkill);
    expect(container.textContent).toContain('code-review');
    expect(container.textContent).toContain('workflow');
    expect(container.textContent).toContain('仅手动执行');
    expect(container.textContent).toContain('斜杠命令');
    expect(container.textContent).toContain('--strict');
    expect(container.querySelector('[role="link"]')?.textContent).toContain(sampleSkill.path);

    await viewSkill();
    expect(client.readHostFile).toHaveBeenCalledWith(sampleSkill.path);
    expect(client.readBuiltinSkill).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('[data-preview-tab]')?.dataset['previewTab']).toBe(sampleSkill.path);
    expect(container.querySelector('[data-preview-tabpanel] h1')?.textContent).toBe('Code Review Instructions');
  });

  it('opens built-in skill content in a distinct read-only SKILL.md tab, never as a host path', async () => {
    const builtin = { ...sampleSkill, name: 'kiki-ops', source: 'builtin' as const, path: 'builtin://kiki-ops' };
    client.readBuiltinSkill.mockResolvedValue('# Kiki operations (kiki-ops)\n\nBuilt-in instructions');
    await renderSkill(builtin);
    expect(container.querySelector('[role="link"]')).toBeNull();
    await viewSkill();
    expect(client.readBuiltinSkill).toHaveBeenCalledExactlyOnceWith('kiki-ops');
    expect(client.readHostFile).not.toHaveBeenCalled();
    const tab = container.querySelector('[data-preview-tab="skill:builtin:kiki-ops"]');
    expect(tab?.textContent).toContain('SKILL.md');
    expect(tab?.textContent).toContain('kiki-ops');
    expect(tab?.getAttribute('title')).toContain('内置');
    expect(container.querySelector('[data-preview-tabpanel="skill:builtin:kiki-ops"] h1')?.textContent).toBe('Kiki operations (kiki-ops)');
    expect(container.textContent).toContain('内置 · 只读');
    expect(container.querySelector('[data-save-button]')).toBeNull();
    expect(container.querySelector('[data-mention-file]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-md-mode="source"]')!.click(); });
    expect(container.querySelector('[data-preview-tabpanel="skill:builtin:kiki-ops"] pre')?.textContent).toContain('Built-in instructions');
    await act(async () => { tab!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    expect(container.querySelector('[data-menu-item="copy-absolute"]')).toBeNull();
    expect(container.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    await viewSkill();
    expect(container.querySelectorAll('[data-preview-tab]')).toHaveLength(1);
    expect(client.readBuiltinSkill).toHaveBeenCalledTimes(1);
  });

  it('closes the agent skill drawer so the opened built-in tab is visible', async () => {
    client.readBuiltinSkill.mockResolvedValue('# Kiki operations (kiki-ops)');
    function Drawer() {
      const [open, setOpen] = useState(true);
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={open ? { kind: 'skill', skill: {
              id: 'builtin:kiki-ops', name: 'kiki-ops', source: 'builtin',
              path: 'builtin://kiki-ops', scope: 'global', state: 'enabled',
            } } : null}
            onClose={() => { setOpen(false); }}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => {
      root.render(<I18nProvider><Drawer /></I18nProvider>);
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('builtin://kiki-ops');
    expect(dialog?.querySelector('[role="link"]')).toBeNull();
    const button = Array.from(dialog!.querySelectorAll('button')).find((item) => item.textContent?.includes('查看 SKILL.md'));
    await act(async () => { button!.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-preview-tab="skill:builtin:kiki-ops"]')).not.toBeNull();
    expect(client.readHostFile).not.toHaveBeenCalled();
    expect(client.readBuiltinSkill).toHaveBeenCalledWith('kiki-ops');
  });
});
