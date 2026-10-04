// @vitest-environment jsdom

/**
 * The persona editor's own contract: one save transaction, a draft that
 * survives a failed write, and a default workspace that goes to the wire as
 * the directory the service actually uses.
 *
 * The persona query mock resolves a real snapshot, so the form is exercised the
 * way /personas drives it. 可见性 and 任务与连接 only render when the roster
 * supplied a summary; these cases pass none, which keeps this file about the
 * draft itself.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaDefinition, PersonaSnapshot } from '@kiki/protocol';
import { clearToasts } from '../../lib/toasts';
import { ApiError, PERSONA_REVISION_CONFLICT } from '../../lib/client';

import { I18nProvider } from '../../i18n';
import { PersonaEditor } from './PersonaEditor';

const navigate = vi.fn();
const getPersona = vi.fn();
const putPersona = vi.fn();
const listWorkspaces = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listModels = vi.fn();

vi.mock('../dirtyGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dirtyGuard')>()),
  useGuardedNavigate: () => navigate,
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../../state/connection', () => {
  const value = () => ({
    client: { getPersona, putPersona, listWorkspaces, listNamedAgentProfiles, listModels, klient: { rest: { personas: {} } } },
    scopeId: 'local',
    sshLabel: null,
  });
  return { useConnection: value, useOptionalConnection: value };
});

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  for (const fn of [navigate, getPersona, putPersona, listWorkspaces, listNamedAgentProfiles, listModels]) fn.mockReset();
  clearToasts();
  localStorage.setItem('kiki.locale', 'zh');
  listNamedAgentProfiles.mockResolvedValue({ items: [] });
  listModels.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

const WORKSPACES = [
  { id: 'wd_release_000000000000', name: 'workshop', root: 'C:/work/workshop', created_at: '', last_opened_at: '', pinned: false, session_count: 0, isGit: true },
];

function snapshot(definition: Partial<PersonaDefinition> & Pick<PersonaDefinition, 'id' | 'name' | 'description'>): PersonaSnapshot {
  return { definition: definition as PersonaDefinition, revision: 'revision-1' };
}

async function render(personaId: string | undefined): Promise<HTMLElement> {
  return (await renderWith(personaId)).container;
}

async function renderWith(personaId: string | undefined): Promise<{ container: HTMLElement; queryClient: QueryClient; rerender: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null,
    createElement(PersonaEditor, {
      personaId,
      takenIds: new Set<string>(),
      onSaved: vi.fn(),
      onClosed: vi.fn(),
    })));
  await act(async () => { root.render(tree()); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // The parent re-renders on every query change, exactly as /personas does.
  const rerender = async () => {
    await act(async () => { root.render(tree()); });
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  return { container, queryClient, rerender };
}

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(container: HTMLElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-persona-field="${name}"]`)!;
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.requestSubmit();
  });
  for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The `i` beside a field's label, which opens that field's fine print. */
function helpBeside(container: HTMLElement, label: string): HTMLButtonElement {
  const heading = [...container.querySelectorAll('label')]
    .find((node) => node.textContent === label)!;
  return heading.parentElement!.querySelector<HTMLButtonElement>('[data-setting-help]')!;
}

async function openHelp(trigger: HTMLButtonElement): Promise<string> {
  await act(async () => { trigger.focus(); });
  for (let index = 0; index < 2; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return document.querySelector('[data-setting-help-bubble]')?.textContent ?? '';
}

describe('what each field says about itself', () => {
  it('keeps description and greeting off the first screen and one hover away', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。' }));
    const container = await render('lin-lan');

    // Neither mechanism note occupies a line of its own any more.
    expect(container.textContent).not.toContain('系统提示词开头');
    expect(container.textContent).not.toContain('不花 token');

    // The same sentences are still reachable beside each label, uncut.
    expect(await openHelp(helpBeside(container, '描述'))).toContain('会放进系统提示词开头，替换「我是谁」这一段。一次性任务写在消息里。');
    expect(await openHelp(helpBeside(container, '开场白'))).toContain('新对话打开时以它的名义显示，不花 token；你回复时才进入上下文。');
  });

  it('leaves the irreversible id consequence and the profile meaning on screen', async () => {
    // These two prevent a mistake rather than explain a mechanism, so they
    // stay where the reader meets the decision.
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    const created = await render(undefined);
    expect(created.textContent).toContain('用于目录名和记忆路径，创建后不能修改。');

    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。' }));
    const existing = await render('lin-lan');
    expect(existing.textContent).toContain('工具、权限和子智能体来自这里。角色本身不带权限。');
  });

  it('saves what was typed whether or not the help was opened', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。', greeting: '早上好。' }));
    putPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。', greeting: '早上好。今天发 0.9。' }));
    const container = await render('lin-lan');

    await openHelp(helpBeside(container, '描述'));
    await fill(field(container, 'description') as HTMLTextAreaElement, '负责发布节奏。');
    await fill(field(container, 'greeting') as HTMLTextAreaElement, '早上好。今天发 0.9。');
    await submit(container);

    const body = putPersona.mock.calls[0]![0] as { definition: PersonaDefinition };
    expect(body.definition).toMatchObject({ description: '负责发布节奏。', greeting: '早上好。今天发 0.9。' });
  });
});

describe('new persona', () => {
  it('creates with the id derived from the name and no revision', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    putPersona.mockResolvedValue(snapshot({ id: 'orin-hale', name: 'Orin Hale', description: '归档整理' }));
    const container = await render(undefined);
    await fill(field(container, 'name') as HTMLInputElement, 'Orin Hale');
    await fill(field(container, 'description') as HTMLTextAreaElement, '归档整理');
    await submit(container);

    expect(putPersona).toHaveBeenCalledTimes(1);
    const body = putPersona.mock.calls[0]![0] as { definition: PersonaDefinition; revision?: string };
    expect(body.definition).toMatchObject({ id: 'orin-hale', name: 'Orin Hale', description: '归档整理' });
    expect(body.revision).toBeUndefined();
  });

  it('stays on screen while the workspace list is still on its way', async () => {
    // A pending workspace query must not rebuild the baseline every render.
    listWorkspaces.mockReturnValue(new Promise(() => {}));
    const container = await render(undefined);
    expect(container.querySelector('[data-persona-editor="new"]')).not.toBeNull();
    expect(container.querySelector('[data-persona-field="name"]')).not.toBeNull();
  });
});

describe('existing persona', () => {
  it('shows the stored workspace as the registered workspace it is, and saves its directory', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({
      id: 'lin-lan', name: '林岚', description: '负责发布节奏。', homeWorkspace: 'C:/work/workshop',
    }));
    putPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。', homeWorkspace: 'C:/work/workshop' }));
    const container = await render('lin-lan');

    // The picker names the workspace, not the path it stores.
    const picker = container.querySelector('[data-persona-field="homeWorkspace"]')!;
    expect(picker.textContent).toContain('workshop');
    expect(picker.textContent).not.toContain('C:/work/workshop');

    await fill(field(container, 'job') as HTMLInputElement, '写发布说明');
    await submit(container);
    const body = putPersona.mock.calls[0]![0] as { definition: PersonaDefinition; revision?: string };
    expect(body.definition.homeWorkspace).toBe('C:/work/workshop');
    expect(body.revision).toBe('revision-1');
  });

  it('keeps the typed draft and says why when the save fails', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。' }));
    putPersona.mockRejectedValue(new Error('disk is read-only'));
    const container = await render('lin-lan');

    await fill(field(container, 'name') as HTMLInputElement, '林岚（发布）');
    await submit(container);

    expect(putPersona).toHaveBeenCalledTimes(1);
    expect((field(container, 'name') as HTMLInputElement).value).toBe('林岚（发布）');
    expect(container.querySelector('[data-persona-save-failure]')?.textContent).toContain('disk is read-only');
    // Still dirty: the save bar is offered again rather than reporting success.
    expect(container.querySelector('[data-settings-draft][data-dirty="true"]')).not.toBeNull();
  });

  it('keeps a stored directory that no workspace registers, and saves it untouched', async () => {
    // An older persona asset may point at an absolute directory this server
    // does not list. That is a valid value, not a missing one: the editor shows
    // it, edits it and writes it back exactly as it stands.
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({ id: 'archive-bot', name: '归档员', description: '整理旧稿。', homeWorkspace: 'C:/legacy/notes' }));
    putPersona.mockResolvedValue(snapshot({ id: 'archive-bot', name: '归档员', description: '整理旧稿。', homeWorkspace: 'C:/legacy/notes' }));
    const container = await render('archive-bot');

    const picker = container.querySelector('[data-persona-field="homeWorkspace"]')!;
    expect(picker.textContent).toContain('C:/legacy/notes');
    expect(picker.getAttribute('data-value')).toBe('path:C:/legacy/notes');

    await fill(field(container, 'job') as HTMLInputElement, '整理旧稿');
    await submit(container);
    const body = putPersona.mock.calls[0]![0] as { definition: PersonaDefinition };
    expect(body.definition.homeWorkspace).toBe('C:/legacy/notes');
  });

  it('re-seeds the form when another persona is opened', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', description: '负责发布节奏。' }));
    const first = await render('lin-lan');
    expect((field(first, 'name') as HTMLInputElement).value).toBe('林岚');

    getPersona.mockResolvedValue(snapshot({ id: 'a-che', name: '阿澈', description: '陪你改稿。' }));
    const second = await render('a-che');
    expect((field(second, 'name') as HTMLInputElement).value).toBe('阿澈');
    expect((field(second, 'description') as HTMLTextAreaElement).value).toBe('陪你改稿。');
  });
});

/**
 * Another window saves the same persona. The read-back that follows is a real
 * server fact, and the form must not spend it by throwing away typing.
 */
describe('a new revision read back while the editor is open', () => {
  it('keeps the unsaved draft, and still saves against the revision it started from', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '负责发布节奏。' } as PersonaDefinition, revision: 'revision-1' });
    const { container, queryClient, rerender } = await renderWith('lin-lan');

    await fill(field(container, 'job') as HTMLInputElement, '写发布说明');
    expect(container.querySelector('[data-settings-draft][data-dirty="true"]')).not.toBeNull();

    // The other window's save lands in the same query cache.
    queryClient.setQueryData(['persona', 'lin-lan'], {
      definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition,
      revision: 'revision-2',
    });
    await rerender();

    // The draft is still here, character for character.
    expect((field(container, 'job') as HTMLInputElement).value).toBe('写发布说明');
    expect((field(container, 'description') as HTMLTextAreaElement).value).toBe('负责发布节奏。');
    expect(container.querySelector('[data-settings-draft][data-dirty="true"]')).not.toBeNull();

    // And the save carries the fact the reader was looking at, so the server
    // refuses it instead of silently overwriting the other window's text.
    putPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '负责发布节奏。' } as PersonaDefinition, revision: 'revision-1' });
    await submit(container);
    const body = putPersona.mock.calls[0]![0] as { revision?: string };
    expect(body.revision).toBe('revision-1');
  });

  it('takes the new revision when the form is clean, and offers it as the conflict reload does', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '负责发布节奏。' } as PersonaDefinition, revision: 'revision-1' });
    const { container, queryClient, rerender } = await renderWith('lin-lan');

    // Nobody typed, so there is nothing to protect.
    queryClient.setQueryData(['persona', 'lin-lan'], {
      definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition,
      revision: 'revision-2',
    });
    await rerender();
    expect((field(container, 'description') as HTMLTextAreaElement).value).toBe('改在另一窗口。');

    // A save after that sends the revision it now believes in.
    putPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition, revision: 'revision-2' });
    await fill(field(container, 'job') as HTMLInputElement, '写发布说明');
    await submit(container);
    const body = putPersona.mock.calls[0]![0] as { revision?: string };
    expect(body.revision).toBe('revision-2');
  });

  it('reads the newer text and the newer revision when the reader takes the conflict reload', async () => {
    listWorkspaces.mockResolvedValue({ items: WORKSPACES });
    getPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '负责发布节奏。' } as PersonaDefinition, revision: 'revision-1' });
    const { container, queryClient, rerender } = await renderWith('lin-lan');

    await fill(field(container, 'job') as HTMLInputElement, '写发布说明');
    queryClient.setQueryData(['persona', 'lin-lan'], {
      definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition,
      revision: 'revision-2',
    });
    await rerender();
    getPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition, revision: 'revision-2' });

    // The reader says "take theirs" through the existing conflict entry.
    putPersona.mockRejectedValue(new ApiError({ code: PERSONA_REVISION_CONFLICT, msg: 'revision conflict', data: null }));
    await submit(container);
    expect(container.querySelector('[data-persona-conflict]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-persona-conflict] button')!.click();
    });
    for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect((field(container, 'description') as HTMLTextAreaElement).value).toBe('改在另一窗口。');
    expect((field(container, 'job') as HTMLInputElement).value).toBe('');
    expect(container.querySelector('[data-settings-draft][data-dirty="true"]')).toBeNull();
    // The next save is against the revision that reload brought back.
    putPersona.mockResolvedValue({ definition: { id: 'lin-lan', name: '林岚', description: '改在另一窗口。' } as PersonaDefinition, revision: 'revision-2' });
    await fill(field(container, 'job') as HTMLInputElement, '写发布说明');
    await submit(container);
    expect((putPersona.mock.calls.at(-1)![0] as { revision?: string }).revision).toBe('revision-2');
  });
});
