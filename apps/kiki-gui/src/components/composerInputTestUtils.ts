import { type TransactionSpec, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { composerInputOf, registerComposerInput, type ComposerInputHandle } from '../lib/composerInput';

export type ComposerSelectionDirection = 'forward' | 'backward' | 'none';

export type ComposerInputElement = HTMLElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: ComposerSelectionDirection;
  disabled: boolean;
  placeholder: string;
  setSelectionRange: (start: number, end: number, direction?: ComposerSelectionDirection) => void;
};

const patchedInputs = new WeakSet<HTMLElement>();
const disabledOverrides = new WeakMap<HTMLElement, { value: boolean; ariaDisabled: string | null }>();

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
}

function viewFor(input: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(input);
  if (view === null) throw new Error('composer input is not attached to a CodeMirror EditorView');
  return view;
}

function selectionFor(view: EditorView): { start: number; end: number; direction: ComposerSelectionDirection } {
  const { anchor, head } = view.state.selection.main;
  if (anchor === head) return { start: anchor, end: head, direction: 'none' };
  return anchor < head
    ? { start: anchor, end: head, direction: 'forward' }
    : { start: head, end: anchor, direction: 'backward' };
}

function patchInput(input: HTMLElement): ComposerInputElement {
  if (!patchedInputs.has(input)) {
    Object.defineProperties(input, {
      value: {
        configurable: true,
        get: () => viewFor(input).state.sliceDoc(),
        set: (value: string) => { setComposerInputValue(input as ComposerInputElement, value); },
      },
      selectionStart: {
        configurable: true,
        get: () => selectionFor(viewFor(input)).start,
      },
      selectionEnd: {
        configurable: true,
        get: () => selectionFor(viewFor(input)).end,
      },
      selectionDirection: {
        configurable: true,
        get: () => selectionFor(viewFor(input)).direction,
      },
      disabled: {
        configurable: true,
        get: () => {
          const ariaDisabled = input.getAttribute('aria-disabled');
          const override = disabledOverrides.get(input);
          if (override === undefined) return ariaDisabled === 'true';
          if (override.ariaDisabled !== ariaDisabled) {
            disabledOverrides.delete(input);
            return ariaDisabled === 'true';
          }
          return override.value;
        },
        set: (value: boolean) => {
          disabledOverrides.set(input, { value, ariaDisabled: input.getAttribute('aria-disabled') });
        },
      },
      placeholder: {
        configurable: true,
        get: () => input.getAttribute('placeholder')
          ?? input.getAttribute('aria-placeholder')
          ?? input.getAttribute('data-placeholder')
          ?? '',
      },
      setSelectionRange: {
        configurable: true,
        value: (start: number, end: number, direction: ComposerSelectionDirection = 'none') => {
          setComposerInputSelection(input as ComposerInputElement, start, end, direction);
        },
      },
    });
    if (composerInputOf(input) === null) {
      const handle: ComposerInputHandle = {
        element: input,
        get value() { return viewFor(input).state.sliceDoc(); },
        get selectionStart() { return selectionFor(viewFor(input)).start; },
        get selectionEnd() { return selectionFor(viewFor(input)).end; },
        get selectionDirection() { return selectionFor(viewFor(input)).direction; },
        get disabled() { return (input as ComposerInputElement).disabled; },
        focus: (options) => { input.focus(options); },
        setSelectionRange: (start, end, direction = 'none') => {
          setComposerInputSelection(input as ComposerInputElement, start, end, direction);
        },
        setRangeText: (text, start = viewFor(input).state.selection.main.from, end = viewFor(input).state.selection.main.to, mode = 'preserve') => {
          const view = viewFor(input);
          const inserted = view.state.toText(text);
          const cursor = start + inserted.length;
          const selection = mode === 'select'
            ? { anchor: start, head: cursor }
            : { anchor: mode === 'start' ? start : cursor };
          view.dispatch({ changes: { from: start, to: end, insert: inserted }, selection, userEvent: 'input' });
        },
        setValueAndCursor: (value, cursor) => {
          const view = viewFor(input);
          const rawAt = Math.max(0, Math.min(cursor, value.length));
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: view.state.toText(value) },
            selection: { anchor: view.state.toText(value.slice(0, rawAt)).length },
            userEvent: 'input',
          });
        },
        select: () => {
          const view = viewFor(input);
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        },
      };
      registerComposerInput(handle);
    }
    patchedInputs.add(input);
  }
  return input as ComposerInputElement;
}

export function composerInput(container: ParentNode): ComposerInputElement {
  const input = container.querySelector<HTMLElement>('[data-composer-input][contenteditable]');
  if (input === null) throw new Error('composer input contentDOM missing');
  viewFor(input);
  return patchInput(input);
}

export function setComposerInputValue(input: ComposerInputElement, value: string): void {
  const view = viewFor(input);
  const current = view.state.doc.length === 0 ? '' : view.state.sliceDoc();
  const next = view.state.toText(String(value));
  const spec: TransactionSpec = {
    selection: { anchor: next.length, head: next.length },
    annotations: Transaction.userEvent.of('input'),
  };
  if (current !== next.toString()) spec.changes = { from: 0, to: view.state.doc.length, insert: next };
  view.dispatch(spec);
}

export function setComposerInputSelection(
  input: ComposerInputElement,
  start: number,
  end = start,
  direction: ComposerSelectionDirection = 'none',
): void {
  const view = viewFor(input);
  const length = view.state.doc.length;
  const boundedStart = Math.max(0, Math.min(start, length));
  const boundedEnd = Math.max(0, Math.min(end, length));
  const from = Math.min(boundedStart, boundedEnd);
  const to = Math.max(boundedStart, boundedEnd);
  view.dispatch({
    selection: direction === 'backward'
      ? { anchor: to, head: from }
      : { anchor: from, head: to },
  });
}
