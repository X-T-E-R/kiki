// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AgentNotesSection, NOTE_SECTION_LABELS, type AgentNotesSectionProps } from './AgentNotesSection';
import { NOTE_SECTIONS } from '../../../../../packages/agent-core-v2/src/session/todo/todoNotes';
import { TodoNotesSchema } from '../../../../../packages/agent-core-v2/src/agent/tools/todo-list/todo-list';
import { todoNotesSchema, transcriptOperationSchema, AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter } from '@kiki/transcript';
import { createViewState, projectAgentTranscriptView } from '@kiki/session-core';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(props: AgentNotesSectionProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><AgentNotesSection {...props} /></I18nProvider>); });
  return {
    container,
    rerender: async (next: AgentNotesSectionProps) => {
      await act(async () => { root.render(<I18nProvider><AgentNotesSection {...next} /></I18nProvider>); });
    },
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const meta = { rev: 4, hash: 'h', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'msg-9', windowEpoch: 2 };

async function openSection(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!;
  await act(async () => { toggle.click(); });
}

describe('AgentNotesSection', () => {
  it('keeps the loading line and the empty line apart', async () => {
    const { container, rerender, cleanup } = await render({ notes: undefined, meta: undefined, loaded: false });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('loading');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Reading working notes…');
    // Neither state folds: there is nothing to unfold yet.
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    await rerender({ notes: undefined, meta: undefined, loaded: true });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('No working notes yet.');
    expect(container.textContent).not.toContain('Reading working notes');
    await cleanup();
  });

  it('reads whitespace-only notes as the empty state, never as content', async () => {
    const { container, cleanup } = await render({ notes: { goal: '  ', next: '\n' }, meta, loaded: true });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.querySelector('[data-agent-notes-part]')).toBeNull();
    await cleanup();
  });

  it('shows the goal line closed and every written section, revision and turn open', async () => {
    const { container, cleanup } = await render({
      notes: { goal: 'Ship the tray fix\nwith tests', next: 'Take screenshots', open: 'Mobile width?' },
      meta,
      loaded: true,
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-agent-notes-section] button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-agent-notes-goal]')?.textContent).toBe('Ship the tray fix');
    expect(container.querySelector('[data-agent-notes-part]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect([...container.querySelectorAll<HTMLElement>('[data-agent-notes-part]')].map((part) => part.dataset['agentNotesPart']))
      .toEqual(['goal', 'next', 'open']);
    // The humanized watermark: turn and revision, never the internal ids.
    const metaLine = container.querySelector('[data-agent-notes-meta]');
    expect(metaLine?.textContent).toBe('Updated in turn 12 · revision 4');
    expect(metaLine?.textContent).not.toContain('context window');
    expect(metaLine?.textContent).not.toContain('t12.3');
    expect(metaLine?.textContent).not.toContain('msg-9');
    await cleanup();
  });

  it('renders all eight sections in the canonical order with their labels', async () => {
    const { container, cleanup } = await render({
      notes: {
        open: 'o', next: 'n', files: 'f', evidence: 'e',
        rejected: 'r', decided: 'd', directives: 'i', goal: 'g',
      },
      meta,
      loaded: true,
    });
    await openSection(container);
    const parts = [...container.querySelectorAll<HTMLElement>('[data-agent-notes-part]')];
    expect(parts.map((part) => part.dataset['agentNotesPart']))
      .toEqual(['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open']);
    const labels = parts.map((part) => part.querySelector('dt')?.textContent);
    expect(labels).toEqual(['Goal', 'User instructions', 'Decided', 'Ruled out', 'Evidence', 'Files', 'Next', 'Open questions']);
    await cleanup();
  });

  it('round-trips core section sentinels through live and cold projection and renders unknown strings safely', async () => {
    const notes = Object.fromEntries(NOTE_SECTIONS.map((section) => [section, `${section}:exact\nsecond line`]));
    expect(Object.keys(TodoNotesSchema.shape)).toEqual([...NOTE_SECTIONS]);
    expect(Object.keys(todoNotesSchema.shape)).toEqual([...NOTE_SECTIONS]);
    expect(Object.keys(NOTE_SECTION_LABELS)).toEqual([...NOTE_SECTIONS]);
    const complete = { ...notes, future_field: '<script>not executable</script>' };
    const record = { type: 'tools.update_store', key: 'todo_notes', value: { notes: complete, notesMeta: meta } };
    const live = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(live);
    const adapter = new TranscriptWireAdapter('main');
    reducer.apply(adapter.add(record));
    const operation = transcriptOperationSchema.parse(JSON.parse(JSON.stringify({ op: 'todo.upsert', todo: live.getTodo('todo') })));
    expect(operation).toMatchObject({ todo: { notes: complete } });
    const cold = new AgentTranscript('main');
    new TranscriptFactReducer(cold).apply(new TranscriptWireAdapter('main').add(JSON.parse(JSON.stringify(record))));
    expect(cold.getTodo('todo')?.notes).toEqual(complete);
    expect(live.getTodo('todo')?.notes).toEqual(complete);
    const projected = projectAgentTranscriptView(createViewState('session'), 'main', live.snapshot());
    expect(projected.todoNotes).toEqual(complete);
    const { container, cleanup } = await render({ notes: projected.todoNotes, meta: projected.todoNotesMeta, loaded: true });
    await openSection(container);
    expect([...container.querySelectorAll<HTMLElement>('[data-agent-notes-part]')].map((node) => node.dataset['agentNotesPart'])).toEqual([...NOTE_SECTIONS, 'future_field']);
    for (const section of NOTE_SECTIONS) expect(container.querySelector(`[data-agent-notes-part="${section}"] dd`)?.textContent).toBe(notes[section]);
    expect(container.textContent).toContain('Newer notes field: future_field');
    expect(container.querySelector('script')).toBeNull();
    await cleanup();
  });

  it('distinguishes incompatible, stale, and explicitly empty notes', async () => {
    const status = { state: 'incompatible' as const, wireOrdinal: 12, schemaVersion: 1, fields: ['notes.future_field'] };
    const { container, rerender, cleanup } = await render({ notes: undefined, meta: undefined, status, loaded: true });
    expect(container.textContent).toContain('Working notes cannot be read right now.');
    expect(container.textContent).not.toContain('No working notes yet.');
    await rerender({ notes: { goal: 'last readable goal' }, meta, status, loaded: true });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Showing the last readable version');
    expect(container.textContent).toContain('last readable goal');
    await rerender({ notes: undefined, meta, loaded: true });
    expect(container.textContent).toContain('Working notes are empty · revision 4');
    expect(container.querySelector('[role="status"]')).toBeNull();
    await cleanup();
  });

  it('clamps a long section to four lines with the shared show-more toggle', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `evidence line ${index}`).join('\n');
    const { container, cleanup } = await render({ notes: { goal: 'g', evidence: long }, meta, loaded: true });
    await openSection(container);
    const evidence = container.querySelector('[data-agent-notes-part="evidence"]')!;
    const paragraph = evidence.querySelector('dd p')!;
    expect(paragraph.className).toContain('line-clamp-4');
    expect(paragraph.className).toContain('whitespace-pre-wrap');
    expect(paragraph.textContent).toContain('evidence line 29');
    await cleanup();
  });

  it('settles back to the empty state when the agent clears its notes', async () => {
    const { container, rerender, cleanup } = await render({
      notes: { goal: 'Temporary goal', next: 'Cleanup' },
      meta,
      loaded: true,
    });
    await openSection(container);
    expect(container.textContent).toContain('Temporary goal');
    // The agent clears its list: the panel must not keep the stale text.
    await rerender({ notes: undefined, meta: undefined, loaded: true });
    expect(container.textContent).not.toContain('Temporary goal');
    expect(container.textContent).not.toContain('Cleanup');
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.textContent).toContain('No working notes yet.');
    await cleanup();
  });
});
