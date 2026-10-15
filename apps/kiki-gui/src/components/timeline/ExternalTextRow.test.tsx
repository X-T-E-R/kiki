// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { ContentRef } from '@kiki/transcript';
import type { ExternalTextNote } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { TranscriptDetailProvider } from '../transcriptDetail';
import { ExternalTextRow } from './ExternalTextRow';
import { MessageViewContext } from '../message/messageViewContext';
import { outputLayerStore } from '../output-layer/outputLayerStore';
import { OutputLayerClient } from '../../lib/outputLayerClient';
import { setActiveOutputLayerClient } from '../output-layer/useOutputLayerClient';

const source = {
  driver: 'external' as const,
  connectionId: 'conn_1',
  clientName: 'ChatGPT',
  sessionRef: 'extref_1',
};

const note = (over: Partial<ExternalTextNote> = {}): ExternalTextNote => ({
  recordId: 'rec_1',
  markerId: 'external-text:rec_1',
  kind: 'handoff',
  text: 'The retry budget is 3 attempts.',
  source,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function render(note_: ExternalTextNote, wrap?: (row: ReactNode) => ReactNode) {
  act(() => {
    root.render(
      <I18nProvider>
        {wrap === undefined
          ? <ExternalTextRow note={note_} createdAt="2026-10-06T00:00:00.000Z" />
          : wrap(<ExternalTextRow note={note_} createdAt="2026-10-06T00:00:00.000Z" />)}
      </I18nProvider>,
    );
  });
  return container.querySelector('[data-xs-external-text]');
}

/**
 * The continuation seam, wrapped around the row: the provider must be an
 * ancestor, because that is how the row reaches the ref in a real session.
 */
function detail(contentRefs: readonly ContentRef[], load: () => void) {
  return (row: ReactNode) => (
    <TranscriptDetailProvider
      load={async () => { load(); return true; }}
      loads={{}}
      contentRefs={contentRefs}
      sessionId="sess_1"
      agentId="main"
    >
      {row}
    </TranscriptDetailProvider>
  );
}

const longRef: ContentRef = {
  path: ['payload', 'text'],
  kind: 'text',
  offset: 40,
  total: 400,
  source: { kind: 'marker', id: 'external-text:rec_1' },
  revision: 'rev-1',
};

const open = (row: Element | null) => {
  const toggle = row?.querySelector<HTMLElement>('[data-xs-external-text-toggle]');
  act(() => { toggle?.click(); });
};

describe('ExternalTextRow', () => {
  it('names the record, its kind and the client that saved it', () => {
    const row = render(note({ title: 'Retry budget handoff' }));
    expect(row?.getAttribute('data-xs-external-text-kind')).toBe('handoff');
    const label = row?.textContent ?? '';
    expect(label).toContain('Retry budget handoff');
    expect(label).toContain('ChatGPT');
    // The body stays shut until asked for; the headline is the title, never
    // the payload inlined into the row.
    expect(row?.querySelector('[data-xs-external-text-body]')).toBeNull();
  });

  it('opens onto the saved body as prose, not as a message bubble', () => {
    const row = render(note({ text: 'The budget is 3 attempts.\n\n- keep the cap\n- log the third' }));
    open(row);
    const body = row?.querySelector('[data-xs-external-text-body]');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain('The budget is 3 attempts.');
    expect(body?.querySelector('li')).not.toBeNull();
    // It is a record the client handed over, so it must not be drawn as one of
    // this session's own turns.
    expect(row?.getAttribute('data-xs-external-text-open')).toBe('true');
  });

  it('offers to read the rest of a body the server cut', () => {
    const row = render(note(), detail([longRef], () => {}));
    open(row);
    const continuation = row?.querySelector('[data-content-continuation]');
    expect(continuation).not.toBeNull();
    // The prefix is on screen and is not claiming to be the whole record: the
    // row reports how much has been read, in the ref's own unit.
    expect(continuation?.textContent).toContain('10% loaded');
    expect(continuation?.textContent).toContain('Continue loading');
  });

  it('reads nothing while the record is still closed', () => {
    let reads = 0;
    const row = render(note(), detail([longRef], () => { reads += 1; }));
    expect(reads).toBe(0);
    expect(row?.querySelector('[data-content-continuation]')).toBeNull();
  });

  it('addresses the read to the real marker id, never the display id', () => {
    // A ref belonging to a different record must not be adopted: it is the
    // server's answer to an address, and the wrong address is a wrong body.
    const otherRef: ContentRef = { ...longRef, source: { kind: 'marker', id: 'external-text:rec_OTHER' } };
    const row = render(note(), detail([otherRef], () => {}));
    open(row);
    expect(row?.querySelector('[data-content-continuation]')).toBeNull();
  });

  it('reads a second record under its own address without mixing the two', () => {
    const second: ContentRef = { ...longRef, path: ['payload', 'text'], offset: 10, total: 90, source: { kind: 'marker', id: 'external-text:rec_2' } };
    const row = render(note(), detail([longRef, second], () => {}));
    open(row);
    const continuations = row?.querySelectorAll('[data-content-continuation]') ?? [];
    expect(continuations).toHaveLength(1);
    // Only this record's own unread part is offered.
    expect(continuations[0]?.getAttribute('data-content-continuation')).not.toBe('loading');
  });

  it('uses the real session for external Assistant excerpts and keeps copy original with zero blank-model requests', async () => {
    const sessionId = 'external-output-session';
    const preset = { id: 'external-empty', label: '外部未选模型', instruction: '翻译', contextWindow: 32768 };
    outputLayerStore.setConfiguration({ enabled: true, presets: [preset], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } }, `local::${sessionId}`);
    outputLayerStore.setActivePreset(sessionId, preset.id);
    const stream = vi.fn();
    const client = new OutputLayerClient({ configuration: vi.fn(), configure: vi.fn(), stream });
    const process = vi.spyOn(client, 'process'); setActiveOutputLayerClient(client);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const original = 'External Assistant original';
    const row = render(note({ kind: 'assistant_excerpt', text: original }), child => <MessageViewContext.Provider value={{ sessionId, internalProse: false }}>{child}</MessageViewContext.Provider>);
    open(row);
    expect(row?.querySelector('[data-output-layer-unconfigured]')).not.toBeNull();
    expect(row?.textContent).toContain(preset.label);
    expect(row?.textContent).toContain(original);
    const copy = Array.from(row!.querySelectorAll('button')).find(button => button.textContent?.includes('复制原文'))!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(original);
    expect(process).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    setActiveOutputLayerClient(null);
    outputLayerStore.setActivePreset(sessionId, null);
    outputLayerStore.setConfiguration(null, `local::${sessionId}`);
  });

  it('falls back to the kind when the client sent no title', () => {
    const row = render(note({ kind: 'user_excerpt', title: '   ' }));
    const label = row?.textContent ?? '';
    expect(label).not.toContain('Retry budget');
    expect(label).toContain('ChatGPT');
  });
});
