// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDescriptor, Workspace } from '@kiki/protocol';
import { ApiError } from '@kiki/session-core/transport';
import { I18nProvider } from '../../i18n';
import { MediaPreviewProvider } from '../mediaPreview';
import { AgentDetailDrawer } from '../agent-panel/AgentDetailDrawer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SkillCard } from './rows';
import { SkillsView } from './SkillsView';
import { CapabilitiesPage } from './CapabilitiesPage';
import { resetListPrefsCache } from '../settings/list';

const client = vi.hoisted(() => ({
  // The options bag is what carries the sheet's abort signal, so the mock keeps
  // the real signature rather than the bare one.
  readHostFile: vi.fn<(path: string, options?: { signal?: AbortSignal }) => Promise<string>>(),
  previewHostFile: vi.fn<(path: string, maxBytes?: number, options?: { signal?: AbortSignal }) => Promise<{ text: string; truncated: boolean }>>(),
  readBuiltinSkill: vi.fn<(name: string, options?: { signal?: AbortSignal }) => Promise<string>>(),
  listWorkspaceSkills: vi.fn<(id: string) => Promise<{ skills: SkillDescriptor[] }>>(),
  listWorkspaces: vi.fn<() => Promise<{ items: Workspace[] }>>(),
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client, scopeId: 'local' }),
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
  client.previewHostFile.mockReset();
  client.readBuiltinSkill.mockReset();
  client.readHostFile.mockReset();
  localStorage.setItem('kiki.locale', 'zh');
  copied.length = 0;
  // The copy control promises what it copies, so the clipboard is observed
  // rather than stubbed away.
  // jsdom ships no clipboard, so one is defined for the copy control to write
  // to. Every other navigator property is left exactly as it is.
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

/** What the copy control actually handed the clipboard, in order. */
const copied: string[] = [];
async function lastCopiedText(): Promise<string | undefined> {
  return copied.at(-1);
}
/** The toast for a finished copy runs after the clipboard promise settles. */
async function settleClipboard(): Promise<void> {
  for (let attempt = 0; attempt < 20 && copied.length === 0; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

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
    client.previewHostFile.mockResolvedValue({ text: '# Code Review Instructions\n\nRun review checks.', truncated: false });
    await renderSkill(sampleSkill);
    expect(container.textContent).toContain('code-review');
    expect(container.textContent).toContain('workflow');
    expect(container.textContent).toContain('仅手动执行');
    expect(container.textContent).toContain('斜杠命令');
    expect(container.textContent).toContain('--strict');
    expect(container.querySelector('[role="link"]')?.textContent).toContain(sampleSkill.path);

    await viewSkill();
    expect(client.previewHostFile).toHaveBeenCalledWith(sampleSkill.path);
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

  it('reads a built-in skill into the open drawer instead of a second surface', async () => {
    client.readBuiltinSkill.mockResolvedValue('# Kiki operations (kiki-ops)\n\nBuilt-in instructions.');
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
    // A built-in skill is never read as a host path.
    expect(client.readHostFile).not.toHaveBeenCalled();
    // The sheet is filled by reading the skill: no click, no second tab, and
    // the reader keeps the drawer they opened.
    expect(dialog?.querySelector('[data-skill-md]')).not.toBeNull();
    for (let attempt = 0; attempt < 30 && dialog!.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    // The read carries the sheet's signal, so leaving it stops the request.
    expect(client.readBuiltinSkill).toHaveBeenCalledWith('kiki-ops', expect.objectContaining({ signal: expect.anything() }));
    const content = dialog!.querySelector('[data-skill-md-content]')!;
    // Rendered as Markdown, which is what a SKILL.md is written in.
    expect(content.querySelector('h1')?.textContent).toBe('Kiki operations (kiki-ops)');
    expect(content.textContent).toContain('Built-in instructions.');
    // The drawer stayed open: the content is here, not in a preview tab.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-preview-tab]')).toBeNull();
    // Copy and the full file stay one click away, without leaving the sheet.
    expect(dialog!.querySelector('[data-skill-md-copy]')).not.toBeNull();
    expect(dialog!.querySelector('[data-skill-md-open]')).not.toBeNull();
  });

  it('reads a file skill through the host read and names the failure with a retry', async () => {
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'project:code-review', name: 'code-review', source: 'project',
              path: sampleSkill.path, scope: 'workspace', state: 'enabled',
              description: '代码审查规则集。',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    client.previewHostFile.mockRejectedValueOnce(new Error('ENOENT'));
    await act(async () => {
      root.render(<I18nProvider><Drawer /></I18nProvider>);
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-retry]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(client.previewHostFile).toHaveBeenCalledWith(sampleSkill.path, undefined, expect.objectContaining({ signal: expect.anything() }));
    expect(client.readBuiltinSkill).not.toHaveBeenCalled();
    // A failed read says what happened and how to get the file anyway.
    expect(dialog.querySelector('[data-skill-md-retry]')).not.toBeNull();
    expect(dialog.textContent).toContain('无法读取这份 SKILL.md');
    expect(dialog.querySelector('[data-skill-md-open]')).not.toBeNull();
    // Retrying reads again, and a success then renders the Markdown.
    client.previewHostFile.mockResolvedValue({ text: '# Code Review\n\nRun review checks.', truncated: false });
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-skill-md-retry]')!.click(); });
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(client.previewHostFile).toHaveBeenCalledTimes(2);
    expect(dialog.querySelector('[data-skill-md-content] h1')?.textContent).toBe('Code Review');
    expect(dialog.querySelector('[data-skill-md-retry]')).toBeNull();
  });

  it('reads a file whose body is JSON as the file it is', async () => {
    // A SKILL.md may legitimately be JSON, and it may open with a "code" field.
    // The read succeeds, so the body is the document: nothing about its shape
    // decides whether it is shown.
    const jsonBody = '{\n  "code": 0,\n  "msg": "the real instructions",\n  "steps": ["one", "two"]\n}\n';
    client.previewHostFile.mockResolvedValue({ text: jsonBody, truncated: false });
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'user:json', name: 'json', source: 'user',
              path: '~/.kiki/skills/json/SKILL.md', scope: 'global', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const content = dialog.querySelector('[data-skill-md-content]');
    expect(content).not.toBeNull();
    expect(dialog.querySelector('[data-skill-md-retry]')).toBeNull();
    // The whole file is on screen, not a message about it.
    expect(content?.textContent).toContain('the real instructions');
    expect(content?.textContent).toContain('"steps"');
  });

  it('names a failed read in the reader\'s words and recovers on retry', async () => {
    // The host answers a missing file with a failed request (HTTP 404 over
    // REST), so the failure arrives as a rejection with the fs wire code. What
    // the reader sees is a sentence, never the code or the host's message.
    client.previewHostFile.mockRejectedValueOnce(new ApiError({ code: 40409, msg: 'fs.path_not_found', data: null }));
    client.previewHostFile.mockResolvedValue({ text: '# Code Review\n\nRun review checks.', truncated: false });
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'user:gone', name: 'gone', source: 'user',
              path: '~/.kiki/skills/gone/SKILL.md', scope: 'global', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-retry]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const alert = dialog.querySelector('[data-skill-md] [role="alert"]')?.textContent ?? '';
    // A specific sentence for "it moved", not the generic one and not a code.
    expect(alert).toContain('已经不在原位置');
    expect(alert).not.toContain('fs.path_not_found');
    expect(alert).not.toContain('40409');
    expect(dialog.querySelector('[data-skill-md-content]')).toBeNull();
    // The file is one click away even when the read failed.
    expect(dialog.querySelector('[data-skill-md-open]')).not.toBeNull();

    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-skill-md-retry]')!.click(); });
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(client.previewHostFile).toHaveBeenCalledTimes(2);
    expect(dialog.querySelector('[data-skill-md-content] h1')?.textContent).toBe('Code Review');
    expect(dialog.querySelector('[data-skill-md-retry]')).toBeNull();
  });

  it('never shows an internal code for a denied file either', async () => {
    client.previewHostFile.mockRejectedValueOnce(new ApiError({ code: 40411, msg: 'fs.permission_denied', data: null }));
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'user:denied', name: 'denied', source: 'user',
              path: '~/.kiki/skills/denied/SKILL.md', scope: 'global', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-retry]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const alert = dialog.querySelector('[data-skill-md] [role="alert"]')?.textContent ?? '';
    expect(alert).toContain('这里读不到');
    expect(alert).not.toContain('40411');
    expect(alert).not.toContain('fs.permission_denied');
  });

  it('falls back to a plain sentence for a failure it cannot name', async () => {
    client.previewHostFile.mockRejectedValueOnce(new Error('socket hang up'));
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'user:weird', name: 'weird', source: 'user',
              path: '~/.kiki/skills/weird/SKILL.md', scope: 'global', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-retry]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const alert = dialog.querySelector('[data-skill-md] [role="alert"]')?.textContent ?? '';
    // A transport string is not an explanation, so it is not what is shown.
    expect(alert).toContain('无法读取这份 SKILL.md');
    expect(alert).not.toContain('socket hang up');
  });

  it('shows a cut preview at once, then reads the rest without being asked', async () => {
    const prefix = '# Big skill\n\nStart of a very long file.';
    const whole = `${prefix}\n\n## Steps\n\n1. Read the range.\n2. Drop what nobody can observe.\n`;
    client.previewHostFile.mockResolvedValue({ text: prefix, truncated: true });
    let releaseWhole!: (value: string) => void;
    client.readHostFile.mockReturnValue(new Promise((done) => { releaseWhole = done; }));
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'project:big', name: 'big', source: 'project',
              path: 'C:/p/big/SKILL.md', scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    // What arrived is already on screen, and the rest is on its way: the
    // reader is not left staring at a spinner over a file they could read.
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Start of a very long file.');
    expect(dialog.querySelector('[data-skill-md-truncated]')?.textContent).toContain('正在读取文件的剩余部分');
    expect(client.readHostFile).toHaveBeenCalledWith('C:/p/big/SKILL.md', expect.objectContaining({ signal: expect.anything() }));

    await act(async () => {
      releaseWhole(whole);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The whole document replaces the prefix, and the boundary notice goes
    // with it: there is nothing left to qualify.
    const content = dialog.querySelector('[data-skill-md-content]')!;
    expect(content.textContent).toContain('Read the range.');
    expect(dialog.querySelector('[data-skill-md-truncated]')).toBeNull();
    expect(dialog.querySelector('[data-skill-md-incomplete]')).toBeNull();
    // Now that the file is whole, the copy control says so.
    const copy = dialog.querySelector<HTMLButtonElement>('[data-skill-md-copy]')!;
    expect(copy.textContent).toBe('复制 SKILL.md');
    await act(async () => { copy.click(); });
    await settleClipboard();
    expect(await lastCopiedText()).toBe(whole);
  });

  it('takes an empty whole file as the file, not as a failure', async () => {
    // A file that was emptied between the preview and the whole read has
    // genuinely become empty. That is a successful read of an empty document,
    // so the read ends, the stale prefix does not survive it, and the copy is
    // the empty document rather than the bytes that used to be there.
    client.previewHostFile.mockResolvedValue({ text: '# Big skill\n\nStart of a very long file.', truncated: true });
    client.readHostFile.mockResolvedValue('');
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'project:big', name: 'big', source: 'project',
              path: 'C:/p/big/SKILL.md', scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    // The whole read is held until the prefix has actually been on screen, so
    // the sequence this test is about is observable rather than raced past.
    let releaseWhole!: () => void;
    client.readHostFile.mockReturnValue(new Promise<string>((done) => { releaseWhole = () => { done(''); }; }));
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30
      && !(dialog.querySelector('[data-skill-md-content]')?.textContent ?? '').includes('Start of a very long file.'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    // The prefix arrived first, so the read was under way.
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Start of a very long file.');
    expect(dialog.querySelector('[data-skill-md-truncated]')).not.toBeNull();

    await act(async () => { releaseWhole(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    // Loading ended: no "reading the rest" line is left behind, and nothing is
    // offered as a failure, because nothing failed.
    expect(dialog.querySelector('[data-skill-md-truncated]')).toBeNull();
    expect(dialog.querySelector('[data-skill-md-incomplete]')).toBeNull();
    expect(dialog.querySelector('[data-skill-md-retry]')).toBeNull();
    // The file is empty now, so the old bytes are gone rather than lingering.
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent?.trim()).toBe('');
    // And the copy is the empty document, not the prefix that used to be there.
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-skill-md-copy]')!.click(); });
    await settleClipboard();
    expect(await lastCopiedText()).toBe('');
  });

  it('keeps the prefix and offers a retry when the rest cannot be read', async () => {
    const prefix = '# Big skill\n\nStart of a very long file.';
    client.previewHostFile.mockResolvedValue({ text: prefix, truncated: true });
    client.readHostFile.mockRejectedValueOnce(new Error('socket hang up'));
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'project:big', name: 'big', source: 'project',
              path: 'C:/p/big/SKILL.md', scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-incomplete]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    // A failed follow-up never takes away what was already read.
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Start of a very long file.');
    const notice = dialog.querySelector('[data-skill-md-incomplete]')!;
    expect(notice.textContent).toContain('没能读到');
    expect(notice.textContent).not.toContain('socket hang up');
    // And the copy still says it is copying what is shown.
    expect(dialog.querySelector('[data-skill-md-copy]')?.textContent).toBe('复制显示的内容');

    // Retrying reads again, and this time the file arrives whole.
    const whole = `${prefix}\n\n## Steps\n\n1. Read the range.\n`;
    client.readHostFile.mockResolvedValue(whole);
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('[data-skill-md-complete-retry]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Read the range.');
    expect(dialog.querySelector('[data-skill-md-incomplete]')).toBeNull();
    const copy = dialog.querySelector<HTMLButtonElement>('[data-skill-md-copy]')!;
    await act(async () => { copy.click(); });
    await settleClipboard();
    expect(await lastCopiedText()).toBe(whole);
  });

  it('abandons the rest-read when the reader moves to another skill', async () => {
    // Each skill gets its own preview, so what is on screen after the switch
    // can only be the new one, and each read gets its own answer.
    client.previewHostFile.mockImplementation(async (path: string) => ({
      text: path.includes('slow') ? '# Slow skill\n\nSlow prefix.' : '# Fast skill\n\nFast prefix.',
      truncated: true,
    }));
    const pending: ((value: string) => void)[] = [];
    client.readHostFile.mockImplementation(() => new Promise<string>((done) => { pending.push(done); }));
    function Drawer({ name }: { name: string }) {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: `project:${name}`, name, source: 'project',
              path: `C:/p/${name}/SKILL.md`, scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    // The first sheet settles on its preview and starts its rest-read.
    await act(async () => { root.render(<I18nProvider><Drawer name="slow" /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && pending.length === 0; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(pending).toHaveLength(1);

    // Moving on starts the new sheet's own read and abandons the old one.
    await act(async () => { root.render(<I18nProvider><Drawer name="fast" /></I18nProvider>); });
    for (let attempt = 0; attempt < 30 && pending.length < 2; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(pending).toHaveLength(2);
    const signals = client.readHostFile.mock.calls.map(
      ([, options]) => (options as { signal?: AbortSignal } | undefined)?.signal);
    // Leaving a sheet aborts the read still in flight for it, rather than
    // leaving it to run against a sheet nobody is looking at.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // The abandoned read lands last and must change nothing on the new sheet.
    await act(async () => {
      pending[0]!('# Slow skill\n\nStale tail.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const shown = dialog.querySelector('[data-skill-md-content]')?.textContent ?? '';
    expect(shown).toContain('Fast prefix.');
    expect(shown).not.toContain('Slow prefix.');
    expect(shown).not.toContain('Stale tail');
  });

  it('copies the whole file when nothing was cut', async () => {
    const whole = '# Code Review\n\nRun review checks.';
    client.previewHostFile.mockResolvedValue({ text: whole, truncated: false });
    function Drawer() {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: 'project:whole', name: 'whole', source: 'project',
              path: 'C:/p/whole/SKILL.md', scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-copy]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const copy = dialog.querySelector<HTMLButtonElement>('[data-skill-md-copy]')!;
    expect(copy.textContent).toBe('复制 SKILL.md');
    await act(async () => { copy.click(); });
    await settleClipboard();
    expect(await lastCopiedText()).toBe(whole);
  });

  it('drops a read that finished after the reader moved on to another skill', async () => {
    // Two skills, the first one slow. The second sheet must never show the
    // first one's text, and a late answer for the first must not paint over it.
    let resolveFirst!: (value: { text: string; truncated: boolean }) => void;
    client.previewHostFile
      .mockReturnValueOnce(new Promise((done) => { resolveFirst = done; }))
      .mockResolvedValue({ text: '# Second skill\n\nSecond body.', truncated: false });
    function Drawer({ name }: { name: string }) {
      return (
        <MediaPreviewProvider>
          <AgentDetailDrawer
            target={{ kind: 'skill', skill: {
              id: `project:${name}`, name, source: 'project',
              path: `C:/p/${name}/SKILL.md`, scope: 'workspace', state: 'enabled',
            } }}
            onClose={() => undefined}
          />
        </MediaPreviewProvider>
      );
    }
    await act(async () => { root.render(<I18nProvider><Drawer name="slow" /></I18nProvider>); });
    await act(async () => { root.render(<I18nProvider><Drawer name="fast" /></I18nProvider>); });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (let attempt = 0; attempt < 30 && dialog.querySelector('[data-skill-md-content]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Second body');
    // The abandoned read arrives last and must change nothing.
    await act(async () => { resolveFirst({ text: '# Slow skill\n\nStale body.', truncated: false }); await new Promise((r) => setTimeout(r, 10)); });
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).toContain('Second body');
    expect(dialog.querySelector('[data-skill-md-content]')?.textContent).not.toContain('Stale body');
    // The two reads asked for their own files.
    expect(vi.mocked(client.previewHostFile).mock.calls.map(([path]) => path))
      .toEqual(['C:/p/slow/SKILL.md', 'C:/p/fast/SKILL.md']);
  });
});

describe('SkillsView at scale', () => {
  const many: SkillDescriptor[] = [
    ...Array.from({ length: 30 }, (_, index) => ({ name: `project-${index}`, description: `Project skill ${index}`, path: `C:/p/${index}/SKILL.md`, source: 'project' as const })),
    ...Array.from({ length: 12 }, (_, index) => ({ name: `kiki-${index}`, description: `Built-in ${index}`, path: `builtin:kiki-${index}`, source: 'builtin' as const })),
    { name: 'incident-notes', description: 'Summarize incident reports', path: 'C:/u/incident/SKILL.md', source: 'user', prompt_command: true },
  ];

  async function renderView() {
    localStorage.setItem('kiki.locale', 'en');
    localStorage.removeItem('kiki.settingsLists');
    resetListPrefsCache();
    client.listWorkspaceSkills.mockResolvedValue({ skills: many });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider>
            <MemoryRouter>
              <MediaPreviewProvider>
                <SkillsView workspaceId="ws" />
              </MediaPreviewProvider>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && container.querySelector('[data-skill-row]') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
  }
  const rows = (group: string) => container.querySelectorAll(`[data-list-group="${group}"] [data-skill-row]`).length;

  it('lists every skill in foldable source groups', async () => {
    await renderView();
    expect(rows('project')).toBe(30);
    expect(rows('builtin')).toBe(12);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-list-group-toggle="project"]')!.click(); });
    expect(rows('project')).toBe(0);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-list-group-toggle="project"]')!.click(); });
    expect(rows('project')).toBe(30);
  });

  it('searches across folded groups and says how many match', async () => {
    await renderView();
    const input = container.querySelector<HTMLInputElement>('[data-skills-view] input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'kiki-1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows('builtin')).toBe(3);
    expect(container.querySelector('[data-list-count]')?.textContent).toBe('3 of 43');
  });
});


describe('CapabilitiesPage workspace skills', () => {
  const workspace = (id: string, name: string): Workspace => ({
    id, name, root: `C:/projects/${name}`, created_at: '2026-01-01T00:00:00Z',
    last_opened_at: '2026-01-01T00:00:00Z', session_count: 1, pinned: false, isGit: false,
  });
  const alpha = workspace('ws_alpha', 'Alpha');
  const beta = workspace('ws_beta', 'Beta');

  beforeEach(() => {
    client.listWorkspaces.mockReset();
    client.listWorkspaceSkills.mockReset().mockImplementation(async (id) => ({
      skills: [{ ...sampleSkill, name: `${id}-review` }],
    }));
  });

  function Navigation() {
    const navigate = useNavigate();
    const location = useLocation();
    return <><button data-test-back onClick={() => { void navigate(-1); }}>Back</button><output data-test-url>{location.search}</output></>;
  }

  async function renderPage(path = '/capabilities?tab=skills') {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider>
            <MemoryRouter initialEntries={[path]}>
              <CapabilitiesPage onToggleSidebar={() => undefined} />
              <Navigation />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function settleUntil(selector: string) {
    for (let attempt = 0; attempt < 40 && container.querySelector(selector) === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(container.querySelector(selector)).not.toBeNull();
  }

  it('shows loading, not an empty workspace, until the workspace request resolves', async () => {
    let resolve!: (value: { items: Workspace[] }) => void;
    client.listWorkspaces.mockReturnValue(new Promise((done) => { resolve = done; }));
    await renderPage();
    expect(container.querySelector('[data-capability-workspaces-loading]')?.textContent).toBe('正在加载工作区…');
    expect(container.querySelector('[data-capability-empty]')).toBeNull();
    expect(client.listWorkspaceSkills).not.toHaveBeenCalled();
    await act(async () => { resolve({ items: [alpha] }); });
    await settleUntil('[data-skill-row="ws_alpha-review"]');
    expect(client.listWorkspaceSkills).toHaveBeenCalledWith(alpha.id);
    expect(container.querySelector('[data-capability-empty]')).toBeNull();
  });

  it('shows a retryable failure, never the no-workspace message', async () => {
    client.listWorkspaces.mockRejectedValueOnce(new Error('Session index is building'));
    client.listWorkspaces.mockResolvedValue({ items: [alpha] });
    await renderPage();
    await settleUntil('[data-capability-workspaces-error]');
    expect(container.textContent).toContain('工作区列表加载失败，请重试。');
    expect(container.textContent).not.toContain('还没有可查看技能的工作区');
    expect(client.listWorkspaceSkills).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-capability-workspaces-error] button')!.click(); });
    await settleUntil('[data-skill-row="ws_alpha-review"]');
    expect(client.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('offers a new session only for a successfully loaded empty catalog and refreshes the catalog', async () => {
    client.listWorkspaces.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [alpha] });
    await renderPage();
    await settleUntil('[data-capability-empty]');
    expect(container.textContent).toContain('还没有可查看技能的工作区');
    expect(container.textContent).toContain('选择一个项目文件夹');
    expect(container.querySelector('[data-capability-empty] a')?.getAttribute('href')).toBe('/new');
    expect(container.textContent).not.toContain('已注册');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-capabilities-refresh]')!.click(); });
    await settleUntil('[data-skill-row="ws_alpha-review"]');
    expect(client.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('switches between every workspace and honors URL changes and browser Back', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [alpha, beta] });
    await renderPage('/capabilities?tab=skills&workspace=ws_beta');
    await settleUntil('[data-skill-row="ws_beta-review"]');
    const trigger = container.querySelector<HTMLButtonElement>('#capabilities-workspace')!;
    expect(trigger.textContent).toContain('Beta');
    await act(async () => { trigger.click(); });
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent?.includes('Alpha'));
    expect(option).toBeDefined();
    await act(async () => { option!.click(); });
    await settleUntil('[data-skill-row="ws_alpha-review"]');
    expect(client.listWorkspaceSkills).toHaveBeenCalledWith(alpha.id);
    expect(container.querySelector('#capabilities-workspace')?.textContent).toContain('Alpha');
    expect(container.querySelector('[data-test-url]')?.textContent).toContain('workspace=ws_alpha');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-test-back]')!.click(); });
    await settleUntil('[data-skill-row="ws_beta-review"]');
    expect(container.querySelector('#capabilities-workspace')?.textContent).toContain('Beta');
    expect(container.querySelector('[data-test-url]')?.textContent).toContain('workspace=ws_beta');
  });

  it('falls back from a removed URL workspace rather than using its stale id', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [alpha] });
    await renderPage('/capabilities?tab=skills&workspace=ws_deleted');
    await settleUntil('[data-skill-row="ws_alpha-review"]');
    expect(client.listWorkspaceSkills).not.toHaveBeenCalledWith('ws_deleted');
  });
});
