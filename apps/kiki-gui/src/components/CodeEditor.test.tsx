// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeEditor } from './CodeEditor';
import type { FileReference } from '@kiki/session-core/composer/media';
import { HostFileEditorController } from '../state/hostFileEditor';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // jsdom has no text layout; assert CM selection and the scroll effect, not pixels.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it.each([true, false])('moves the live editor without replacing its buffer (readOnly=%s)', async (readOnly) => {
  const onChange = vi.fn();
  const scroll = vi.spyOn(EditorView, 'scrollIntoView');
  const text = 'first\nsecond line\nlast';
  const render = async (navigation: FileReference) => {
    await act(async () => {
      root.render(<CodeEditor path="/work/example.txt" value={text} generation={1} readOnly={readOnly} onChange={onChange} ariaLabel="Source" navigation={navigation} />);
    });
  };
  await render({ path: '/work/example.txt', line: 2, column: 4 });
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  expect(view.state.selection.main.head).toBe(9);
  expect(scroll).toHaveBeenLastCalledWith(9, { y: 'center' });
  expect(view.state.doc.toString()).toBe(text);
  expect(onChange).not.toHaveBeenCalled();

  const dirtyText = readOnly ? text : `${text}\nunsaved edit`;
  if (!readOnly) {
    act(() => { view.dispatch({ changes: { from: text.length, insert: '\nunsaved edit' } }); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(dirtyText);
  }
  const changesBeforeNavigation = onChange.mock.calls.length;
  await render({ path: '/work/example.txt', line: 999, column: 999 });
  expect(EditorView.findFromDOM(container.querySelector('.cm-editor')!)).toBe(view);
  expect(view.state.selection.main.head).toBe(dirtyText.length);
  expect(view.state.doc.toString()).toBe(dirtyText);
  await render({ path: '/work/example.txt', line: 1 });
  expect(view.state.selection.main.head).toBe(0);
  expect(view.state.doc.toString()).toBe(dirtyText);
  expect(onChange).toHaveBeenCalledTimes(changesBeforeNavigation);
  await render({ path: '/work/example.txt', line: 2, endLine: 3 });
  expect(view.state.selection.main.anchor).toBe(6);
  expect(view.state.selection.main.head).toBe(22);
  expect(scroll).toHaveBeenLastCalledWith(6, { y: 'center' });
  expect(view.state.doc.toString()).toBe(dirtyText);
  expect(onChange).toHaveBeenCalledTimes(changesBeforeNavigation);
});

const NEUTRAL = 'Neutral text control.\n\r\n';

function quietEvents(): Pick<typeof window, 'addEventListener' | 'removeEventListener'> {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

async function renderEditor(props: {
  path?: string;
  value: string;
  generation: number;
  readOnly: boolean;
  onChange: (text: string) => void;
}): Promise<EditorView> {
  await act(async () => {
    root.render(
      <CodeEditor
        path={props.path ?? '/work/example.txt'}
        value={props.value}
        generation={props.generation}
        readOnly={props.readOnly}
        onChange={props.onChange}
        ariaLabel="Source"
      />,
    );
  });
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
  if (view === null) throw new Error('editor did not mount');
  return view;
}

it.each([
  ['lf', 'alpha\nbeta\n', '\n', 'alpha'],
  ['crlf', 'alpha\r\nbeta\r\n', '\r\n', 'alpha'],
  ['cr', 'alpha\rbeta\r', '\r', 'alpha'],
  ['mixed', NEUTRAL, '\n', 'Neutral text control.'],
])('loading %s bytes does not report an edit', async (_label, text, lineBreak, firstLine) => {
  const onChange = vi.fn();
  const view = await renderEditor({ value: text, generation: 1, readOnly: false, onChange });
  if (text === NEUTRAL) expect(text.length).toBe(24);
  expect(onChange).not.toHaveBeenCalled();
  expect(view.state.lineBreak).toBe(lineBreak);
  expect(view.state.doc.line(1).text).toBe(firstLine);
  if (lineBreak === '\n' && text.includes('\r')) {
    expect(view.state.doc.line(2).text).toBe('');
    expect(view.state.sliceDoc()).toBe('Neutral text control.\n\n');
  } else {
    expect(view.state.sliceDoc()).toBe(text);
  }
});

it('keeps a CRLF file clean, preserves breaks on save, and accepts an external reload', async () => {
  const original = 'alpha\r\nbeta\r\n';
  const disk = { content: original };
  const writes: string[] = [];
  const controller = new HostFileEditorController({
    path: '/work/example.txt',
    readFile: async () => disk.content,
    writeFile: async (_path, text) => {
      writes.push(text);
      disk.content = text;
    },
    events: quietEvents(),
  });
  await controller.load();
  const onChange = vi.fn((text: string) => { controller.setDraft(text); });
  const render = (generation: number, value: string) => renderEditor({
    value,
    generation,
    readOnly: false,
    onChange,
  });
  let view = await render(controller.getState().generation, controller.getState().draft);
  expect(controller.getState()).toMatchObject({ dirty: false, savedText: original, draft: original });
  await controller.saveNow();
  expect(writes).toEqual([]);
  expect(disk.content).toBe(original);

  const insertedAt = view.state.doc.line(1).to;
  act(() => { view.dispatch({ changes: { from: insertedAt, insert: `${view.state.lineBreak}tail` } }); });
  const edited = 'alpha\r\ntail\r\nbeta\r\n';
  expect(onChange).toHaveBeenLastCalledWith(edited);
  expect(controller.getState()).toMatchObject({ dirty: true, draft: edited, savedText: original });
  act(() => { view.dispatch({ changes: { from: insertedAt, to: view.state.doc.line(2).to, insert: '' } }); });
  expect(onChange).toHaveBeenLastCalledWith(original);
  expect(controller.getState()).toMatchObject({ dirty: false, draft: original, savedText: original });
  await controller.saveNow();
  expect(writes).toEqual([]);

  act(() => { view.dispatch({ changes: { from: 0, insert: 'Z' } }); });
  const saved = 'Zalpha\r\nbeta\r\n';
  expect(controller.getState().draft).toBe(saved);
  await controller.saveNow();
  expect(writes).toEqual([saved]);
  expect(disk.content).toBe(saved);
  expect(controller.getState()).toMatchObject({ dirty: false, savedText: saved });

  disk.content = 'next\r\nfile\r\n';
  await controller.load();
  const callsAfterReload = onChange.mock.calls.length;
  view = await render(controller.getState().generation, controller.getState().draft);
  expect(onChange).toHaveBeenCalledTimes(callsAfterReload);
  expect(controller.getState()).toMatchObject({ dirty: false, savedText: disk.content, draft: disk.content });
  expect(view.state.lineBreak).toBe('\r\n');
  expect(view.state.doc.line(1).text).toBe('next');
  expect(view.state.sliceDoc()).toBe(disk.content);
  act(() => { view.dispatch({ changes: { from: 0, insert: 'Q' } }); });
  expect(controller.getState().draft).toBe('Qnext\r\nfile\r\n');
  await controller.saveNow();
  expect(writes).toEqual([saved, 'Qnext\r\nfile\r\n']);
  expect(disk.content).toBe('Qnext\r\nfile\r\n');
  controller.dispose();
});

it('preserves mixed breaks across edits and restores the loaded bytes when the text returns', async () => {
  const original = 'keep\nthis\r\norder\n';
  const disk = { content: original };
  const writes: string[] = [];
  const controller = new HostFileEditorController({
    path: '/work/example.txt',
    readFile: async () => disk.content,
    writeFile: async (_path, text) => {
      writes.push(text);
      disk.content = text;
    },
    events: quietEvents(),
  });
  await controller.load();
  const onChange = vi.fn((text: string) => { controller.setDraft(text); });
  const view = await renderEditor({
    value: controller.getState().draft,
    generation: controller.getState().generation,
    readOnly: false,
    onChange,
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(controller.getState().dirty).toBe(false);
  expect(view.state.doc.lines).toBe(4);
  expect(view.state.doc.line(2).text).toBe('this');

  act(() => { view.dispatch({ changes: { from: 0, insert: 'X' } }); });
  expect(controller.getState()).toMatchObject({ dirty: true, draft: 'Xkeep\nthis\r\norder\n' });
  const order = view.state.doc.line(3);
  act(() => { view.dispatch({ changes: { from: order.from, insert: 'Y' } }); });
  const edited = 'Xkeep\nthis\r\nYorder\n';
  expect(controller.getState()).toMatchObject({ dirty: true, draft: edited });
  act(() => { view.dispatch({ changes: { from: view.state.doc.line(3).from, to: view.state.doc.line(3).from + 1, insert: '' } }); });
  act(() => { view.dispatch({ changes: { from: 0, to: 1, insert: '' } }); });
  expect(controller.getState()).toMatchObject({ dirty: false, draft: original, savedText: original });
  await controller.saveNow();
  expect(writes).toEqual([]);
  expect(disk.content).toBe(original);

  act(() => { view.dispatch({ changes: { from: 0, insert: 'X' } }); });
  const saved = 'Xkeep\nthis\r\norder\n';
  expect(controller.getState().draft).toBe(saved);
  await controller.saveNow();
  expect(writes).toEqual([saved]);
  expect(disk.content).toBe(saved);
  const thisLine = view.state.doc.line(2).from;
  act(() => { view.dispatch({ changes: { from: thisLine, insert: 'Z' } }); });
  expect(controller.getState().draft).toBe('Xkeep\nZthis\r\norder\n');
  controller.dispose();
});

it('saves mixed breaks outside two ranges in one transaction and undo restores the loaded bytes', async () => {
  const original = 'Aaa\nBbb\r\nCcc\rDdd';
  const edited = 'XXX\nBbb\r\nCcc\rYYY';
  const disk = { content: original };
  const writes: string[] = [];
  const controller = new HostFileEditorController({
    path: '/work/example.txt',
    readFile: async () => disk.content,
    writeFile: async (_path, text) => {
      writes.push(text);
      disk.content = text;
    },
    events: quietEvents(),
  });
  await controller.load();
  const onChange = vi.fn((text: string) => { controller.setDraft(text); });
  const view = await renderEditor({
    value: controller.getState().draft,
    generation: controller.getState().generation,
    readOnly: false,
    onChange,
  });
  const first = view.state.doc.line(1);
  const last = view.state.doc.line(4);
  act(() => {
    view.dispatch({
      changes: [
        { from: first.from, to: first.to, insert: 'XXX' },
        { from: last.from, to: last.to, insert: 'YYY' },
      ],
    });
  });
  expect(controller.getState()).toMatchObject({ dirty: true, draft: edited, savedText: original });
  await controller.saveNow();
  expect(writes).toEqual([edited]);
  expect(disk.content).toBe(edited);

  act(() => { undo(view); });
  expect(controller.getState()).toMatchObject({ dirty: true, draft: original, savedText: edited });
  await controller.saveNow();
  expect(writes).toEqual([edited, original]);
  expect(disk.content).toBe(original);
  controller.dispose();
});

it('does not report edits from a read-only view, including a later external replacement', async () => {
  const onChange = vi.fn();
  const view = await renderEditor({ value: NEUTRAL, generation: 1, readOnly: true, onChange });
  expect(view.state.doc.line(1).text).toBe('Neutral text control.');
  act(() => { view.dispatch({ changes: { from: 0, insert: 'Z' } }); });
  expect(onChange).not.toHaveBeenCalled();
  await renderEditor({ value: 'alpha\r\nbeta\r\n', generation: 2, readOnly: true, onChange });
  expect(onChange).not.toHaveBeenCalled();
  expect(view.state.sliceDoc()).toBe('alpha\r\nbeta\r\n');
  expect(view.state.lineBreak).toBe('\r\n');
  expect(view.state.doc.line(1).text).toBe('alpha');
});
