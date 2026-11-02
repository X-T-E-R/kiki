// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerInput, setComposerInputValue, type ComposerInputElement } from '../components/composerInputTestUtils';
import { useNavigationComposerFocus } from './navigationComposerFocus';
import { registerOverlay } from './uiBusy';

let root: Root;
let mount: HTMLDivElement;
let endpoint: ComposerInputElement;
let editor: EditorView;
const frames = new Map<number, FrameRequestCallback>();
let seq = 0;
function Focus({ session }: { session: string }) {
  useNavigationComposerFocus('test-home', session);
  return null;
}
async function flush() {
  await act(async () => { await Promise.resolve(); });
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of pending) callback(0); });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++seq, callback); return seq; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  const editorHost = document.createElement('div');
  document.body.append(editorHost);
  editor = new EditorView({
    parent: editorHost,
    state: EditorState.create(),
  });
  endpoint = editor.contentDOM as ComposerInputElement;
  endpoint.setAttribute('contenteditable', 'true');
  endpoint.tabIndex = 0;
  endpoint.dataset['composerInput'] = '';
  endpoint.dataset['composer'] = '';
  endpoint.dataset['composerSession'] = 'a';
  endpoint.dataset['composerAgent'] = 'main';
  endpoint.getClientRects = () => [{ width: 100, height: 40 }] as unknown as DOMRectList;
  composerInput(document.body);
});
afterEach(async () => {
  await act(async () => root.unmount());
  editor.destroy();
  document.body.replaceChildren();
  frames.clear();
  vi.unstubAllGlobals();
});
describe('navigation composer focus ownership', () => {
  it('waits for the current enabled endpoint, not an old composer, then focuses only once', async () => {
    const focus = vi.spyOn(endpoint, 'focus');
    await act(async () => root.render(<Focus session="b" />));
    await flush();
    expect(document.activeElement).not.toBe(endpoint);
    endpoint.dataset['composerSession'] = 'b';
    endpoint.setAttribute('aria-disabled', 'true');
    await flush();
    expect(document.activeElement).not.toBe(endpoint);
    endpoint.setAttribute('aria-disabled', 'false');
    await flush();
    expect(document.activeElement).toBe(endpoint);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    endpoint.dataset['backgroundUpdate'] = 'changed';
    await flush();
    expect(document.activeElement).toBe(other);
  });
  it('preserves a draft selection when the resident node returns to that session', async () => {
    await act(async () => root.render(<Focus session="a" />));
    await flush();
    setComposerInputValue(endpoint, 'draft text');
    endpoint.setSelectionRange(2, 6, 'backward');
    endpoint.dispatchEvent(new Event('select', { bubbles: true }));
    await act(async () => root.render(<Focus session="b" />));
    endpoint.dataset['composerSession'] = 'b';
    setComposerInputValue(endpoint, 'other draft');
    await flush();
    await act(async () => root.render(<Focus session="a" />));
    endpoint.dataset['composerSession'] = 'a';
    setComposerInputValue(endpoint, 'draft text');
    await flush();
    expect([endpoint.selectionStart, endpoint.selectionEnd, endpoint.selectionDirection]).toEqual([2, 6, 'backward']);
  });
  it('does not override a modal or terminal, and cancels a delayed request when the user focuses elsewhere', async () => {
    const close = registerOverlay('focus-test-dialog');
    await act(async () => root.render(<Focus session="a" />));
    await flush();
    expect(document.activeElement).not.toBe(endpoint);
    close();
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    const input = document.createElement('input');
    terminal.append(input);
    document.body.append(terminal);
    input.focus();
    await act(async () => root.render(<Focus session="b" />));
    await flush();
    expect(document.activeElement).toBe(input);
    input.blur();
    await act(async () => root.render(<Focus session="c" />));
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    endpoint.dataset['composerSession'] = 'c';
    await flush();
    expect(document.activeElement).toBe(other);
  });
  it('does not steal focus from an already-focused search input when route arrives', async () => {
    const searchInput = document.createElement('input');
    searchInput.dataset['searchBox'] = 'true';
    document.body.append(searchInput);
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    await act(async () => root.render(<Focus session="d" />));
    endpoint.dataset['composerSession'] = 'd';
    await flush();
    expect(document.activeElement).toBe(searchInput);
  });
});
