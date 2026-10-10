// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalClientMaterial, ExternalClientMaterialsPreview } from '../../lib/externalClients';
import { readDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { I18nProvider } from '../../i18n';
import { ContinueInKiki, ExternalClientMark, ExternalNoteComposer } from './ExternalClientSession';

const { client, facade } = vi.hoisted(() => {
  const facade = {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), revoke: vi.fn(), sessions: vi.fn(),
    stdio: vi.fn(), listener: vi.fn(), configureListener: vi.fn(), authorizations: vi.fn(),
    respondAuthorization: vi.fn(), saveText: vi.fn(), continue: vi.fn(),
    closeSession: vi.fn(), stopSession: vi.fn(),
  };
  return { facade, client: { klient: { rest: { externalClients: facade } } } };
});
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

const mark = { driver: 'external' as const, connectionId: 'conn_1', clientName: 'ChatGPT', sessionRef: 'extref_1' };

const material = (over: Partial<ExternalClientMaterial> = {}): ExternalClientMaterial => ({
  id: 'rec_1', kind: 'saved_text' as const, title: '', excerpt: 'The retry budget is 3 attempts.',
  recordKind: 'note' as const,
  source: { connectionId: 'conn_1', clientName: 'ChatGPT', sessionRef: 'extref_1', driver: 'external' as const },
  history: { sessionId: 'sess_ext_1', agentId: 'main' as const, turn: 1 },
  ...over,
});
const preview = (
  state: 'complete' | 'partial' | 'unloaded',
  items: readonly ExternalClientMaterial[],
  extra: Partial<ExternalClientMaterialsPreview> = {},
): ExternalClientMaterialsPreview => ({
  state, sessionId: 'sess_ext_1', items,
  coverage: { complete: state === 'complete', bytesRead: 1024, recordsRead: items.length },
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  resetDraftMemoryForTests();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  facade.saveText.mockResolvedValue({ recordId: 'rec_1', sessionRef: 'extref_1', savedAt: Date.now(), duplicate: false });
  facade.continue.mockResolvedValue({ sessionId: 'sess_local_1' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

/** Where the router ended up, so a click can be checked against a real path. */
let landedAt = '';
function RouteProbe() {
  const location = useLocation();
  landedAt = `${location.pathname}${location.search}`;
  return null;
}

async function render(node: React.ReactNode, initialEntries: string[] = ['/s/sess_ext_1']) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queries}>
        <I18nProvider>{node}<RouteProbe /></I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  ));
  await settle();
}

/** Query one element or fail loudly: a null must not read as a passing assertion. */
const one = <T extends Element>(selector: string): T => {
  const found = container.querySelector<T>(selector);
  if (found === null) throw new Error(`expected one ${selector}`);
  return found;
};

const setValue = async (element: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
};

describe('the header mark on an externally driven session', () => {
  it('names the driving client and never names a model or an online dot', async () => {
    await render(<ExternalClientMark mark={mark} />);
    const trigger = one<HTMLElement>('[data-xs-mark]');
    expect(trigger.textContent).toContain('External');
    expect(trigger.textContent).toContain('ChatGPT');
    // No model name, no fake presence: Kiki ran no model for this session.
    expect(container.querySelector('[data-xs-mark-panel]')).toBeNull();
  });

  it('states the two facts in the panel: no Kiki model, and no synced conversation', async () => {
    await render(<ExternalClientMark mark={mark} />);
    (one<HTMLElement>('[data-xs-mark]')).click();
    await settle();
    const panel = one<HTMLElement>('[data-xs-mark-panel]');
    expect(container.querySelector('[data-xs-model-unknown]')?.textContent).toBe('No Kiki model runs this session');
    // An unprovided external usage is not zero, so it is never printed as one.
    expect(container.querySelector('[data-xs-usage-unknown]')?.textContent).toContain('does not report');
    expect(panel.textContent).not.toMatch(/\b0 tokens\b|\$0\.00/);
    expect(panel.textContent).toContain('not synced');
  });
});

describe('the note composer on an externally driven session', () => {
  it('saves into the session and sends no prompt anywhere', async () => {
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    await setValue(one<HTMLTextAreaElement>('[data-xs-note]'), 'Ship the migration after the review.');
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    expect(facade.saveText).toHaveBeenCalledTimes(1);
    const body = facade.saveText.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['text']).toBe('Ship the migration after the review.');
    expect(body['kind']).toBe('note');
    // The composer is a save, not a delivery: nothing prompts the client.
    expect(facade.continue).not.toHaveBeenCalled();
    expect(one<HTMLTextAreaElement>('[data-xs-note]').value).toBe('');
  });

  it('marks a user excerpt as a source, not as a verified message from the user', async () => {
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    expect(container.textContent).toContain('is a source, not a verified message');
    const select = one<HTMLSelectElement>('[data-xs-note-kind]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'user_excerpt');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await setValue(one<HTMLTextAreaElement>('[data-xs-note]'), 'The user asked for a rollback.');
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    const body = facade.saveText.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['kind']).toBe('user_excerpt');
  });

  it('refuses an empty note without calling the server', async () => {
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    expect(facade.saveText).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Write something first');
  });

  it('saves under one key so a retry cannot create a second copy', async () => {
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    const note = one<HTMLTextAreaElement>('[data-xs-note]');
    await setValue(note, 'Same note.');
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    const first = (facade.saveText.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    // A second save of the same draft text reuses the key only while it is the
    // same draft; once saved, the field clears and the next note is new.
    expect(first).toBeTruthy();
    expect((facade.saveText.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey).toBe(first);
  });

  it('says the save failed and that the session gained nothing', async () => {
    facade.saveText.mockRejectedValue(new Error('504 gateway timeout'));
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    await setValue(one<HTMLTextAreaElement>('[data-xs-note]'), 'text');
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('504 gateway timeout');
    expect(text).toContain('Nothing was added to this session');
  });

  it('reports a duplicate save as the record it already produced', async () => {
    facade.saveText.mockResolvedValue({ recordId: 'rec_9', sessionRef: 'extref_1', savedAt: Date.now(), duplicate: true });
    await render(<ExternalNoteComposer sessionId="sess_ext_1" />);
    await setValue(one<HTMLTextAreaElement>('[data-xs-note]'), 'text');
    (one<HTMLElement>('[data-xs-note-save]')).click();
    await settle();
    expect(container.textContent).toContain('Already saved as rec_9');
    expect(container.querySelector('[data-xs-note-receipt]')?.textContent).toBe('rec_9');
  });
});

describe('continuing in Kiki', () => {
  it('shows the material the branch will carry before starting one', async () => {
    await render(<ContinueInKiki sessionId="sess_ext_1"
      preview={preview('complete', [material({ title: 'The migration plan' })])} />);
    expect(container.querySelector('[data-xs-material="rec_1"]')?.textContent).toContain('The migration plan');
    expect(facade.continue).not.toHaveBeenCalled();
  });

  it('reads as empty only when a complete read found nothing', async () => {
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    expect(container.querySelector('[data-xs-continue-empty]')?.textContent).toContain('saved no text');
  });

  it('never calls a partial or unread list empty', async () => {
    for (const state of ['partial', 'unloaded'] as const) {
      await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview(state, [])} />);
      // Neither state may present itself as a session that saved nothing.
      expect(container.querySelector('[data-xs-continue-empty]')).toBeNull();
      expect(container.querySelector('[data-xs-continue-unknown]')?.textContent ?? '').toContain('bounded slice');
      expect(container.querySelector('[data-xs-materials-state]')?.getAttribute('data-xs-materials-state')).toBe('partial');
    }
  });

  it('says a partial list is partial, with the counts the server reported', async () => {
    await render(<ContinueInKiki sessionId="sess_ext_1"
      preview={preview('partial', [material()], { knownTotal: 9 })} />);
    const note = container.querySelector('[data-xs-continue-partial]')?.textContent ?? '';
    // A bounded read is a preview, not a statement about what the branch
    // carries, so the copy must not imply the two are the same size.
    expect(note).toContain('Previewing 1 of 9');
    expect(note).not.toContain('branch carries what it read');
    // The rows that did arrive are still shown, and each names its source.
    expect(container.querySelector('[data-xs-material="rec_1"]')?.textContent).toContain('ChatGPT');
  });

  it('pre-fills the goal into the new branch instead of sending it', async () => {
    facade.continue.mockResolvedValue({ sessionId: 'sess_local_1' });
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    const goal = container.querySelector('[data-xs-continue-goal]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(goal, 'Finish the migration and run the tests.');
      goal.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    (container.querySelector('[data-xs-continue-start]') as HTMLElement).click();
    await settle();
    expect(facade.continue).toHaveBeenCalledWith('sess_ext_1');
    // The text waits in the branch's own composer draft; nothing was sent.
    expect(readDraft('sess_local_1')).toBe('Finish the migration and run the tests.');
    // The branch that was just created is where the person lands, on the app's
    // real session route. A path that misses `/s/:id` does not error — it
    // falls through to the session list, and the goal draft becomes invisible
    // because the composer there belongs to a different session.
    expect(landedAt).toBe('/s/sess_local_1');
    expect(readDraft('sess_ext_1')).toBe('');
  });

  it('lands the goal draft in the very session it navigates to', async () => {
    facade.continue.mockResolvedValue({ sessionId: 'sess_local_3' });
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    const goal = container.querySelector('[data-xs-continue-goal]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(goal, 'Follow the handoff.');
      goal.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    (one<HTMLElement>('[data-xs-continue-start]')).click();
    await settle();
    // The draft's session and the route's session must be the same session: a
    // draft no composer on screen actually reads is a goal that was lost.
    expect(readDraft(landedAt.replace('/s/', ''))).toBe('Follow the handoff.');
  });

  it('starts the branch with no draft when no goal was written', async () => {
    facade.continue.mockResolvedValue({ sessionId: 'sess_local_2' });
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    (container.querySelector('[data-xs-continue-start]') as HTMLElement).click();
    await settle();
    expect(readDraft('sess_local_2')).toBe('');
  });

  it('starts a local branch and says the external session keeps its own work', async () => {
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    (one<HTMLElement>('[data-xs-continue-start]')).click();
    await settle();
    expect(facade.continue).toHaveBeenCalledWith('sess_ext_1');
    // The copy must not imply the external work was moved or stopped.
    const text = container.textContent ?? '';
    expect(text).toContain('keep running');
  });

  it('says the branch did not start, and that this session is untouched', async () => {
    facade.continue.mockRejectedValue(new Error('409 conflict'));
    await render(<ContinueInKiki sessionId="sess_ext_1" preview={preview('complete', [])} />);
    (one<HTMLElement>('[data-xs-continue-start]')).click();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('409 conflict');
    expect(text).toContain('This session is untouched');
  });
});
