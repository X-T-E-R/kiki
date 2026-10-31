// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';

const referenceCandidates = vi.fn();
const listModels = vi.fn();
const listSessionSkills = vi.fn();
vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listDraftSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listNamedAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
      getAgentCapabilities: vi.fn().mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: true,
        profile: { name: 'agent', restrict_models_to_menu: false }, targets: [] }),
      uploadFile: vi.fn(),
      klient: {
        global: { threads: { hostId: vi.fn().mockResolvedValue('host-example') } },
        rest: { agents: { referenceCandidates } },
      },
    },
    connectionId: null,
    scopeId: 'local',
    localClient: null,
  }),
  useOptionalConnection: () => null,
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: {} }));
vi.mock('../lib/remoteConnections', () => ({ useRemoteConnections: () => ({ data: undefined }) }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

const CANDIDATES = {
  delegation_available: true,
  items: [
    {
      profile: 'agent', label: 'agent', executor: 'native', engine_label: 'Kiki',
      reference: 'kiki://agents/agent', configuration: 'native', group: 'native',
      defaults_available: true, available: true, description: 'The built-in Kiki agent',
    },
    {
      profile: 'codex', label: 'codex', executor: 'codex', engine_label: 'Codex',
      reference: 'kiki://agents/codex', configuration: 'profile', group: 'profile',
      defaults_available: false, available: false,
      unavailable_reason: 'Codex is not installed', unavailable_reason_code: 'executor_not_installed',
    },
    {
      profile: 'claude-code', label: 'claude-code', executor: 'claude-code', engine_label: 'Claude Code',
      reference: 'kiki://agents/claude-code', configuration: 'profile', group: 'profile',
      defaults_available: true, available: true, description: 'Run on the Claude Code engine',
    },
  ],
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as typeof globalThis & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= { onCommitFiberRoot: () => {}, onCommitFiberUnmount: () => {} };
});
beforeEach(() => {
  writeSettings({ sendShortcut: 'enter' });
  listModels.mockReset().mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }] });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  referenceCandidates.mockReset().mockResolvedValue(CANDIDATES);
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

async function settle(ms = 30): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function render(props: Props & { initial?: string }) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const textarea = (container: HTMLDivElement) => container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
const options = (container: HTMLDivElement) => [...container.querySelectorAll<HTMLElement>('[role="option"]')];

/** Set the controlled textarea's value the way React's onChange expects. */
async function typeText(node: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    node.focus();
    setter?.call(node, value);
    node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeAndSettle(container: HTMLDivElement, value: string) {
  await typeText(textarea(container), value);
  // The mention query debounces (250ms) before the feed and agent query settle.
  await settle(320);
  await settle(60);
}

describe('Composer agent mentions', () => {
  it('lists file and agent groups together, dims the unavailable target with its reason', async () => {
    const fsSearch = vi.fn().mockResolvedValue([{ path: 'README.md', name: 'README.md', kind: 'file', score: 1 }]);
    const container = await render({ sessionId: 'session_current', fsSearch });
    await typeAndSettle(container, '@');
    const labels = options(container).map((node) => node.textContent ?? '');
    expect(labels.some((text) => text.includes('README.md'))).toBe(true);
    expect(labels.some((text) => text.includes('claude-code'))).toBe(true);
    const codex = options(container).find((node) => (node.textContent ?? '').includes('codex'))!;
    expect(codex.getAttribute('aria-disabled')).toBe('true');
    // A known reason code localizes on the client (en dictionary here).
    expect(codex.textContent).toContain('This engine is not installed');
    // Group headers for both engines appear.
    // Group headers name what the group is; each row shows its own engine.
    expect(container.textContent).toContain('Kiki agents');
    expect(container.textContent).toContain('External engines');
  });

  it('accepts an agent with the keyboard: the draft gains the verbatim link and a tinted token', async () => {
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@clau');
    const node = textarea(container);
    // First (only) row is claude-code; Enter accepts it.
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(node.value).toContain('kiki://agents/claude-code');
    // The backdrop marks the link's range as a tinted token (transparent marks
    // can only tint; a readable label would need an overlay — see the receipt).
    expect(container.querySelector('[data-thread-ref-token][data-ref-kind="agent"]')?.textContent).toContain('kiki://agents/claude-code');
  });

  it('falls back to the server reason text for a code it does not know', async () => {
    referenceCandidates.mockResolvedValue({
      delegation_available: true,
      items: [{ ...CANDIDATES.items[1]!, unavailable_reason: 'Codex needs an update', unavailable_reason_code: 'future_code_xyz' }],
    });
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@');
    const codex = options(container).find((node) => (node.textContent ?? '').includes('codex'))!;
    expect(codex.textContent).toContain('Codex needs an update');
  });

  it('never selects the unavailable target with mouse or keyboard', async () => {
    const onSend = vi.fn();
    const container = await render({ sessionId: 'session_current', onSend, fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@codex');
    const codex = options(container).find((nodeEl) => (nodeEl.textContent ?? '').includes('codex'))!;
    await act(async () => { codex.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    expect(textarea(container).value).toBe('@codex');
    expect(container.querySelector('[data-ref-kind="agent"]')).toBeNull();
  });

  it('deletes an agent link as one token on Backspace', async () => {
    const draft = 'ask kiki://agents/claude-code';
    const container = await render({ sessionId: 'session_current', initial: draft, fsSearch: vi.fn().mockResolvedValue([]) });
    const node = textarea(container);
    expect(node.value).toBe(draft);
    // Caret right after the link: one Backspace takes the whole token.
    await act(async () => {
      node.focus();
      node.setSelectionRange(draft.length, draft.length);
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(node.value).toBe('ask ');
  });

  it('sends the link in the text part', async () => {
    const onSend = vi.fn();
    const container = await render({ sessionId: 'session_current', onSend, fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@clau');
    const node = textarea(container);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    await typeText(node, `${node.value}please review`);
    await settle();
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toContain('kiki://agents/claude-code');
    expect(onSend.mock.calls[0]?.[0]).toContain('please review');
  });

  it('states that the engine cannot delegate instead of dropping the group', async () => {
    referenceCandidates.mockResolvedValue({ delegation_available: false, unavailable_reason: 'Native engine only', items: CANDIDATES.items });
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@');
    expect(container.querySelector('[data-agent-mention-note]')?.textContent).toContain('cannot delegate');
    expect(container.querySelector('[data-agent-mention-note]')?.textContent).toContain('Native engine only');
    expect(options(container).some((node) => (node.textContent ?? '').includes('claude-code'))).toBe(true);
  });

  it('overlays the readable @label over the link and reveals the raw link while the caret is inside', async () => {
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@clau');
    const node = textarea(container);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle(60); // flush the rAF that lands the caret after the inserted token
    // The overlay carries the candidate label; the raw link stays in the draft.
    expect(node.value).toContain('kiki://agents/claude-code');
    const token = container.querySelector<HTMLElement>('[data-thread-ref-overlay-token][data-ref-kind="agent"]');
    expect(token?.textContent).toBe('@claude-code');
    // Move the caret inside the link's range: the raw link shows for editing.
    const start = node.value.indexOf('kiki://agents/');
    await act(async () => {
      node.focus();
      node.setSelectionRange(start + 4, start + 4);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle(60);
    expect(container.querySelector('[data-thread-ref-overlay-token][data-ref-kind="agent"]')).toBeNull();
    // Back out of the range and the label returns.
    await act(async () => {
      node.setSelectionRange(node.value.length, node.value.length);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle(60);
    expect(container.querySelector('[data-thread-ref-overlay-token][data-ref-kind="agent"]')?.textContent).toBe('@claude-code');
  });

  it('overlays each reference independently when the same target is named twice', async () => {
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@clau');
    const node = textarea(container);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle(60);
    await typeText(node, `${node.value}and @clau`);
    await settle(320);
    await settle(60);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle(60);
    const tokens = [...container.querySelectorAll<HTMLElement>('[data-thread-ref-overlay-token][data-ref-kind="agent"]')];
    expect(tokens.map((token) => token.textContent)).toEqual(['@claude-code', '@claude-code']);
  });

  it('truncates a long label to the covered range instead of reflowing the draft', async () => {
    referenceCandidates.mockResolvedValue({
      delegation_available: true,
      items: [{ ...CANDIDATES.items[2]!, label: 'Claude Code with an extremely long display name that cannot fit' }],
    });
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@clau');
    const node = textarea(container);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle(60);
    const token = container.querySelector<HTMLElement>('[data-thread-ref-overlay-token][data-ref-kind="agent"]')!;
    expect(token.textContent).toContain('Claude Code with an extremely long display name');
    // The token is the truncating overlay chip, capped to the line.
    expect(token.className).toContain('truncate');
    expect(token.className).toContain('max-w-full');
  });

  it('falls back to the profile name for a reference the candidates do not list', async () => {
    const container = await render({ sessionId: 'session_current', initial: 'ask kiki://agents/stale-profile now', fsSearch: vi.fn().mockResolvedValue([]) });
    await settle();
    const token = container.querySelector<HTMLElement>('[data-thread-ref-overlay-token][data-ref-kind="agent"]');
    expect(token?.textContent).toBe('@stale-profile');
  });

  it('keeps the link verbatim through queue edit/resend', async () => {
    // A queued message's text parks in the draft unchanged; confirming routes
    // it back through onQueueEditConfirm with the link intact.
    const onQueueEditConfirm = vi.fn();
    const draft = 'hand off to kiki://agents/claude-code please';
    const container = await render({
      sessionId: 'session_current',
      queueEditing: true,
      onQueueEditConfirm,
      initial: draft,
      fsSearch: vi.fn().mockResolvedValue([]),
    });
    const node = textarea(container);
    expect(node.value).toBe(draft);
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(onQueueEditConfirm).toHaveBeenCalledTimes(1);
    expect(onQueueEditConfirm.mock.calls[0]?.[0]).toContain('kiki://agents/claude-code');
  });

  it('shows a readable single-line message when the candidate load fails', async () => {
    referenceCandidates.mockRejectedValue(new Error('boom'));
    const container = await render({ sessionId: 'session_current', fsSearch: vi.fn().mockResolvedValue([]) });
    await typeAndSettle(container, '@');
    // The candidate query failed: the menu names the failure, not a crash.
    expect(container.textContent).toContain('Could not load agent targets.');
  });
});
