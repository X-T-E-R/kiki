// @vitest-environment jsdom

/**
 * The leave-then-create order, proved against the REAL dirty guard.
 *
 * HooksSection marks its page dirty through the same `reportDirty` channel
 * `SettingsDraftFooter` uses, so pressing the handoff with a half-written rule
 * must ask before leaving. This file deliberately does NOT mock `dirtyGuard`:
 * cancelling that prompt has to leave no session behind, no draft written and
 * the editor exactly as it was.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { AskKikiButton, useAskKiki } from './askKiki';
import {
  DirtyGuardContext, useDirtyGuardState, useDirtyReporter,
  type DirtyGuardState, type DirtyGuardValue,
} from './dirtyGuard';

const client = { createSession: vi.fn(async () => ({ id: 'hooks-ask-session' })) };
vi.mock('../state/connection', () => ({ useConnection: () => ({ client, scopeId: 'local' }) }));
const rawNavigate = vi.fn();

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
const guardRef: { current: DirtyGuardState | null } = { current: null };
/** The live guard state, read at assert time (it is a fresh object per render). */
const guard = () => guardRef.current!;
/**
 * What the app puts on the context: the `DirtyGuardValue` half, with the
 * fields the contract actually declares, so this harness cannot drift into
 * passing a whole `DirtyGuardState` where a `DirtyGuardValue` belongs.
 */
const guardContextValue = (): DirtyGuardValue => {
  const { dirty, reportDirty, navigate, runAction, confirmDiscard } = guard().value;
  return { dirty, reportDirty, navigate, ...(runAction === undefined ? {} : { runAction }), ...(confirmDiscard === undefined ? {} : { confirmDiscard }) };
};
const flush = async () => { for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

function PageDirtyReporter({ dirty }: { readonly dirty: boolean }) {
  useDirtyReporter('hooks', dirty);
  return null;
}

/**
 * HooksSection's toolbar. The app provides `guard.value` (the DirtyGuardValue)
 * on the context and keeps `confirm`/`cancel`/`pending` on the state object it
 * returns, so this harness does the same — that split is what makes the leave
 * prompt appear at all.
 */
function Harness({ dirty }: { readonly dirty: boolean }) {
  guardRef.current = useDirtyGuardState({ pathname: '/settings/hooks', search: '', hash: '' }, rawNavigate);
  return (
    <DirtyGuardContext.Provider value={guardContextValue()}>
      {/* The reporter reads the guard from context, so it has to be inside it —
          this is exactly how SettingsDraftFooter marks the page dirty. */}
      <PageDirtyReporter dirty={dirty} />
      <AskKikiHandoff />
    </DirtyGuardContext.Provider>
  );
}

function AskKikiHandoff() {
  const { ask } = useAskKiki();
  return (
    <AskKikiButton
      label="帮我配置"
      labelAria="让 Kiki 帮你配置 Hooks 规则"
      busy={false}
      testId="data-hooks-ask-kiki"
      onAsk={() => { void ask({ skill: 'kiki-hooks', promptKey: 'st.hooks.askKiki.prompt' }); }}
    />
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.createSession.mockClear();
  rawNavigate.mockClear();
  resetDraftMemoryForTests();
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); query.clear(); });

async function mount(dirty: boolean) {
  await act(async () => root.render(
    <MemoryRouter><QueryClientProvider client={query}><I18nProvider><Harness dirty={dirty} /></I18nProvider></QueryClientProvider></MemoryRouter>,
  ));
  await flush(); await flush();
}
const press = async () => {
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-hooks-ask-kiki]')!.click(); });
  await flush(); await flush();
};

describe('the handoff leaves before it creates', () => {
  it('creates nothing when the user cancels the leave prompt', async () => {
    await mount(true);

    expect(guard().value.dirty, 'page reports dirty').toBe(true);

    await press();

    // The guard is holding the action: still on the page, nothing created.
    expect(guard().pending, 'leave prompt is up').toBe(true);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(readDraft('hooks-ask-session')).toBe('');

    await act(async () => { guard().cancel(); });
    await flush();

    // Cancelling leaves the user exactly where they were.
    expect(client.createSession).not.toHaveBeenCalled();
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(readDraft('hooks-ask-session')).toBe('');
    expect(guard().value.dirty).toBe(true);
  });

  it('creates once and prefills once the leave is confirmed', async () => {
    await mount(true);

    await press();
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => { await guard().confirm(); });
    await flush(); await flush(); await flush();

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(readDraft('hooks-ask-session')).toMatch(/^\/kiki-hooks /);
  });

  it('creates immediately, with no prompt in the way, when nothing is dirty', async () => {
    await mount(false);
    expect(guard().value.dirty).toBe(false);

    await press();
    await flush(); await flush();

    expect(guard().pending).toBe(false);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(readDraft('hooks-ask-session')).toMatch(/^\/kiki-hooks /);
  });

  it('releases the press after a failed create, so the retry is possible', async () => {
    await mount(false);
    client.createSession.mockRejectedValueOnce(new Error('server offline'));

    await press();
    await flush(); await flush();

    expect(rawNavigate).not.toHaveBeenCalled();
    expect(readDraft('hooks-ask-session')).toBe('');

    // The latch is released, so a second press can try again.
    client.createSession.mockResolvedValueOnce({ id: 'hooks-ask-session' });
    await press();
    await flush(); await flush();

    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(readDraft('hooks-ask-session')).toMatch(/^\/kiki-hooks /);
  });
});
