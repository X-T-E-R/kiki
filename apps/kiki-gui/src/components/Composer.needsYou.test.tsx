// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';

const listModels = vi.fn();
vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels,
      listSessionSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listWorkspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listDraftSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listNamedAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
      uploadFile: vi.fn(),
    },
  }),
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: {} }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  writeSettings({ sendShortcut: 'enter' });
  listModels.mockReset().mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }] });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

type Props = Partial<Parameters<typeof Composer>[0]>;

const decision = (footer: React.ReactNode) => (
  <section data-test-decision>
    <p>Approve Bash?</p>
    {footer}
  </section>
);

async function renderComposer(props: Props) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (next: Props) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              <Composer
                busy={false} disabled={false} value="" onChange={() => {}}
                model={undefined} defaultModel={undefined} serverDefaultModel="fixture/kiki-pro"
                modelSource="server-default" agentProfileCatalogMode={{ mode: 'global' }}
                permissionMode="manual" planMode={false} efforts={undefined} effort={undefined}
                attachments={[]} onChangeAttachments={() => {}} onChangeModel={() => {}}
                onChangePermissionMode={() => {}} onChangePlanMode={() => {}} onChangeEffort={() => {}}
                onSend={() => {}}
                {...next}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  return { container, rerender };
}

const textarea = (container: HTMLElement) => container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
const body = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-composer-body]')!;

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('Composer needs-you takeover', () => {
  it('takes an empty card over: the decision is the body, the input stays mounted but hidden', async () => {
    const { container } = await renderComposer({ needsYou: { count: 1, render: decision } });
    expect(container.querySelector('[data-composer-takeover]')).not.toBeNull();
    expect(container.querySelector('[data-test-decision]')).not.toBeNull();
    expect(body(container).hidden).toBe(true);
    expect(textarea(container)).not.toBeNull();
    expect(container.querySelector('[data-needs-you-banner]')).toBeNull();
  });

  it('keeps a card with a draft: a bar offers the decision, a click takes over, back restores the caret', async () => {
    const { container } = await renderComposer({ value: 'half a thought', needsYou: { count: 2, render: decision } });
    expect(container.querySelector('[data-composer-takeover]')).toBeNull();
    const banner = container.querySelector<HTMLButtonElement>('[data-needs-you-banner]')!;
    expect(banner.textContent).toContain('2 items need you');

    const input = textarea(container);
    input.focus();
    input.setSelectionRange(4, 4);
    await click(banner);
    expect(container.querySelector('[data-composer-takeover]')).not.toBeNull();
    const back = container.querySelector<HTMLButtonElement>('[data-needs-you-back]')!;
    expect(back.textContent).toContain('Draft kept');
    expect(back.querySelector('[data-needs-you-draft]')?.textContent).toBe('half a thought');

    await click(back);
    await act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); }); });
    expect(container.querySelector('[data-composer-takeover]')).toBeNull();
    expect(body(container).hidden).toBe(false);
    expect(document.activeElement).toBe(textarea(container));
    expect(textarea(container).selectionStart).toBe(4);
    expect(textarea(container).value).toBe('half a thought');
  });

  it('holds off while the caret is in an empty input, and takes over once it leaves', async () => {
    const { container, rerender } = await renderComposer({});
    await act(async () => { textarea(container).focus(); });
    await rerender({ needsYou: { count: 1, render: decision } });
    expect(container.querySelector('[data-composer-takeover]')).toBeNull();
    expect(container.querySelector('[data-needs-you-banner]')).not.toBeNull();
    await act(async () => { textarea(container).blur(); });
    expect(container.querySelector('[data-composer-takeover]')).not.toBeNull();
  });

  it('takes over when a decision arrives after a send that left the caret in the input', async () => {
    const onSend = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({ value: 'go', onSend });
    await act(async () => { textarea(container).focus(); });
    await act(async () => {
      textarea(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalled();
    await rerender({ value: '', onSend, needsYou: { count: 1, render: decision } });
    expect(container.querySelector('[data-composer-takeover]')).not.toBeNull();
  });

  it('offers the card again after a release when a new item arrives', async () => {
    const { container, rerender } = await renderComposer({ needsYou: { count: 1, render: decision } });
    await click(container.querySelector('[data-needs-you-back]')!);
    // Back puts the caret in the input on the next frame; then the user leaves.
    await act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); }); });
    await act(async () => { textarea(container).blur(); });
    expect(container.querySelector('[data-composer-takeover]')).toBeNull();
    await rerender({ needsYou: { count: 2, render: decision } });
    expect(container.querySelector('[data-composer-takeover]')).not.toBeNull();
  });

  it('keeps Stop on the status line while the card is taken over', async () => {
    const onAbort = vi.fn();
    const { container } = await renderComposer({ busy: true, onAbort, needsYou: { count: 1, render: decision } });
    const stop = container.querySelector<HTMLButtonElement>('[data-composer-status-stop]')!;
    await click(stop);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe('Composer notes pill', () => {
  const notes = [
    { id: 'n1', quote: 'only the last fifty turns', comment: 'match the server cap' },
    { id: 'n2', quote: '20 turns per page', comment: 'same on mobile?' },
  ];

  it('folds unsent notes into one pill; clicking lists each with locate, edit and remove', async () => {
    const onRemove = vi.fn();
    const onUpdate = vi.fn();
    const onLocate = vi.fn();
    const { container } = await renderComposer({
      annotations: notes, onRemoveAnnotation: onRemove, onUpdateAnnotation: onUpdate, onLocateAnnotation: onLocate,
    });
    const pills = container.querySelectorAll('[data-composer-notes-pill]');
    expect(pills).toHaveLength(1);
    expect(pills[0]!.textContent).toBe('2 notes');
    expect(container.querySelector('[data-annotation-chip]')).toBeNull();

    await click(pills[0]!);
    const rows = container.querySelectorAll('[data-composer-note]');
    expect(rows).toHaveLength(2);
    const locate = rows[0]!.querySelector<HTMLButtonElement>('[data-composer-note-locate]')!;
    expect(locate.textContent).toBe('');
    expect(locate.getAttribute('aria-label')).toBe('Show');
    expect(locate.title).toBe('Show');
    expect(locate.querySelector('[data-icon="arrowUpRight"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(locate.parentElement?.classList.contains('ml-auto')).toBe(true);
    expect(locate.parentElement?.classList.contains('justify-end')).toBe(true);
    for (const action of rows[0]!.querySelectorAll<HTMLButtonElement>('button')) {
      expect(action.classList.contains('w-7')).toBe(true);
      expect(action.classList.contains('min-h-7')).toBe(true);
      expect(action.classList.contains('justify-center')).toBe(true);
    }
    await click(locate);
    expect(onLocate).toHaveBeenCalledWith(notes[0]);
    await click(rows[1]!.querySelector('[data-composer-note-remove]')!);
    expect(onRemove).toHaveBeenCalledWith('n2');

    await click(rows[0]!.querySelector('[data-composer-note-edit]')!);
    const input = container.querySelector<HTMLInputElement>('[data-composer-note-input]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'match page_size');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('[data-composer-note-save]')!);
    expect(onUpdate).toHaveBeenCalledWith('n1', 'match page_size');
  });

  it('closes the list on Escape and returns focus to the pill', async () => {
    const { container } = await renderComposer({ annotations: notes });
    const pill = container.querySelector<HTMLButtonElement>('[data-composer-notes-pill]')!;
    await click(pill);
    expect(container.querySelector('[data-composer-notes-panel]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-composer-notes-panel]')).toBeNull();
    expect(document.activeElement).toBe(pill);
  });
});
