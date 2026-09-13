// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeEditor } from './CodeEditor';
import type { FileReference } from '@kiki/session-core/composer/media';

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
});
