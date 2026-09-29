// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@kiki/protocol';

import { requestComposerInsert } from '@kiki/session-core/composer';
import { writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';

const REF_ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const listModels = vi.fn();
const listSessionSkills = vi.fn();
const getSession = vi.fn();
vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listNamedAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
      uploadFile: vi.fn(),
      getSession,
    },
  }),
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: {} }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

function referenced(): Session {
  return {
    id: REF_ID,
    workspace_id: 'wd_kiki',
    title: 'Fix the flaky upload test',
    created_at: '2026-01-01T10:00:00.000Z',
    updated_at: '2026-01-01T11:30:00.000Z',
    busy: true,
    pending_interaction: 'none',
    metadata: { cwd: 'C:/src/kiki' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0,
    },
    permission_rules: [],
    message_count: 3,
    last_seq: 3,
  };
}

const workspace: Workspace = {
  id: 'wd_kiki', root: 'C:/src/kiki', name: 'kiki', created_at: '2026-01-01T00:00:00.000Z',
  last_opened_at: '2026-01-01T00:00:00.000Z', session_count: 1, pinned: false,
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  writeSettings({ sendShortcut: 'enter' });
  listModels.mockReset().mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }] });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  getSession.mockReset().mockRejectedValue(new Error('not found'));
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

function Harness({ initial = '', ...props }: Props & { initial?: string }) {
  const [text, setText] = useState(initial);
  return (
    <Composer
      busy={false} disabled={false} value={text} onChange={setText}
      model={undefined} defaultModel={undefined} serverDefaultModel="fixture/kiki-pro"
      modelSource="server-default" agentProfileCatalogMode={{ mode: 'global' }}
      permissionMode="manual" planMode={false} efforts={undefined} effort={undefined}
      attachments={[]} onChangeAttachments={() => {}} onChangeModel={() => {}}
      onChangePermissionMode={() => {}} onChangePlanMode={() => {}} onChangeEffort={() => {}}
      onSend={() => {}}
      {...props}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

async function render(props: Props & { initial?: string }, seed?: (client: QueryClient) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <Harness {...props} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 4; index += 1) await settle();
  return container;
}

const seedLists = (client: QueryClient) => {
  client.setQueryData(['sessions', false, undefined], { pages: [{ items: [referenced()], has_more: false }], pageParams: [undefined] });
  client.setQueryData(['workspaces'], { items: [workspace] });
};

const textarea = (container: HTMLDivElement) => container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
const sendButton = (container: HTMLDivElement) => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('Composer thread links', () => {
  it('sends a message that starts with /s/<id> without the unknown-command prompt', async () => {
    const onSend = vi.fn();
    const container = await render({ sessionId: 'session_current', onSend, initial: `/s/${REF_ID} what did this thread decide?` }, seedLists);
    await click(sendButton(container));
    await settle();
    expect(container.querySelector('[data-slash-confirm]')).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toMatch(new RegExp(`^/s/${REF_ID} what did this thread decide\\?\\n\\n<thread_refs>`));
  });

  it('still stops a real unknown command for confirmation', async () => {
    const onSend = vi.fn();
    const container = await render({ sessionId: 'session_current', onSend, initial: '/sessionz list' });
    await click(sendButton(container));
    await settle();
    expect(container.querySelector('[data-slash-confirm]')?.textContent).toContain('No command /sessionz');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('attaches the thread context block the model reads, shaped from the cached record', async () => {
    const onSend = vi.fn();
    const container = await render({ sessionId: 'session_current', onSend, initial: `compare with /s/${REF_ID}` }, seedLists);
    await click(sendButton(container));
    await settle();
    expect(onSend.mock.calls[0]?.[0]).toBe(
      `compare with /s/${REF_ID}\n\n<thread_refs>\n` +
        `<thread_ref id="${REF_ID}" title="Fix the flaky upload test" workspace="kiki" workspace_id="wd_kiki" ` +
        'cwd="C:/src/kiki" status="running" updated_at="2026-01-01T11:30:00.000Z"/>\n' +
        'The user linked the Kiki threads above. Read one with ThreadRead (ThreadList returns the host_id it needs) ' +
        'or search it with HistorySearch (scope=session, session_id=<id>).\n</thread_refs>',
    );
    // The record came from the cache: no extra fetch.
    expect(getSession).not.toHaveBeenCalled();
  });

  it('shows a tray chip with title, workspace and status, and removes the whole link from it', async () => {
    const container = await render({ sessionId: 'session_current', initial: `see /s/${REF_ID} now` }, seedLists);
    const chip = container.querySelector<HTMLElement>(`[data-thread-ref-chip="${REF_ID}"]`)!;
    expect(chip.textContent).toContain('Fix the flaky upload test');
    expect(chip.textContent).toContain('kiki');
    expect(chip.getAttribute('data-thread-ref-status')).toBe('running');
    expect(container.querySelector('[data-thread-ref-token]')?.textContent).toBe(`/s/${REF_ID}`);
    await click(chip.querySelector('button[aria-label^="Remove link to"]')!);
    await settle();
    expect(textarea(container).value).toBe('see now');
    expect(container.querySelector('[data-thread-ref-chip]')).toBeNull();
  });

  it('falls back to the short id for a thread it cannot resolve', async () => {
    const container = await render({ sessionId: 'session_current', initial: `/s/${REF_ID}` });
    expect(getSession).toHaveBeenCalledWith(REF_ID);
    expect(container.querySelector(`[data-thread-ref-chip="${REF_ID}"]`)?.textContent).toContain('Thread 0f8e2a4c');
  });

  it('deletes a link as one token on Backspace', async () => {
    const draft = `a /s/${REF_ID}`;
    const container = await render({ sessionId: 'session_current', initial: draft }, seedLists);
    const node = textarea(container);
    node.setSelectionRange(draft.length, draft.length);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); });
    await settle();
    expect(node.value).toBe('a ');
  });

  it('inserts a link at the caret when the sidebar asks this session\'s composer', async () => {
    const container = await render({ sessionId: 'session_current', initial: 'before after' }, seedLists);
    const node = textarea(container);
    await act(async () => {
      node.focus();
      node.setSelectionRange(7, 7);
    });
    let accepted = false;
    await act(async () => { accepted = requestComposerInsert('session_current', `/s/${REF_ID}`); });
    await settle();
    expect(accepted).toBe(true);
    expect(node.value).toBe(`before /s/${REF_ID} after`);
    expect(requestComposerInsert('session_other', '/s/x')).toBe(false);
  });
});
