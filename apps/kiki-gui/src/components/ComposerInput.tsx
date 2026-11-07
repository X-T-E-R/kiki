import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { insertNewline, standardKeymap } from '@codemirror/commands';
import { findAgentRefs, findConversationRefs } from '@kiki/session-core/composer';
import { normalizeComposerText, registerComposerInput, type ComposerInputHandle } from '../lib/composerInput';

export interface ComposerReferenceLabel {
  readonly raw: string;
  readonly label: string;
}

class ReferenceWidget extends WidgetType {
  constructor(readonly raw: string, readonly label: string, readonly kind: string) { super(); }
  override eq(other: ReferenceWidget): boolean {
    return this.raw === other.raw && this.label === other.label && this.kind === other.kind;
  }
  toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'composer-reference';
    chip.dataset['threadRefToken'] = '';
    chip.dataset['threadRefOverlayToken'] = '';
    chip.dataset['refKind'] = this.kind;
    chip.title = `${this.label}\n${this.raw}`;
    chip.textContent = this.label;
    chip.setAttribute('aria-label', `${this.label}: ${this.raw}`);
    return chip;
  }
  override ignoreEvent(): boolean { return false; }
}

const refreshReferences = StateEffect.define<null>();

/** Adapt CodeMirror's replace-decoration/atomicRanges pattern; raw links remain in the document. */
function referenceDecorations(state: EditorState, labels: readonly ComposerReferenceLabel[]): DecorationSet {
  const names = new Map(labels.map(({ raw, label }) => [raw, label]));
  const refs = [
    ...findConversationRefs(state.sliceDoc()),
    ...findAgentRefs(state.sliceDoc()).map((ref) => ({ ...ref, kind: 'agent' })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const selection = state.selection.main;
  return Decoration.set(refs.map((ref) => {
    const inside = selection.empty && selection.head > ref.start && selection.head < ref.end;
    return inside
      ? Decoration.mark({ class: 'composer-reference-source', attributes: { 'data-ref-kind': ref.kind, 'data-thread-ref-token': '' } }).range(ref.start, ref.end)
      : Decoration.replace({ widget: new ReferenceWidget(ref.raw, names.get(ref.raw) ?? ref.raw, ref.kind), inclusive: false }).range(ref.start, ref.end);
  }));
}

interface ComposerInputProps {
  readonly inputRef: RefObject<ComposerInputHandle | null>;
  readonly value: string;
  readonly references: readonly ComposerReferenceLabel[];
  readonly disabled: boolean;
  readonly label: string;
  readonly placeholder: string;
  readonly sessionId?: string;
  readonly agentId: string;
  readonly autoFocus?: boolean;
  readonly enterKeyHint?: string;
  readonly onChange: (value: string, cursor: number) => void;
  readonly onSelection: (cursor: number) => void;
  readonly onKeyDown: (event: globalThis.KeyboardEvent) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
  readonly onPaste: (event: ClipboardEvent) => void;
}

const inputTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--color-ink)', fontSize: 'inherit', outline: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.625', overflow: 'auto', maxHeight: '190px' },
  '.cm-content': { padding: '2px 0', minHeight: '28px', caretColor: 'var(--color-ink)', overflowWrap: 'anywhere' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--color-ink-faint)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--color-selected)' },
});

export function ComposerInput(props: ComposerInputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const config = useRef(new Compartment());
  const externalChange = useRef(false);
  const labelsRef = useRef(props.references);
  labelsRef.current = props.references;
  const configuration = () => {
    const current = propsRef.current;
    return [
      EditorState.readOnly.of(current.disabled),
      EditorView.editable.of(!current.disabled),
      placeholder(current.placeholder),
      EditorView.contentAttributes.of(() => {
        const attributes: Record<string, string> = {
          'aria-label': current.label,
          'aria-multiline': 'true',
          'aria-disabled': String(current.disabled),
          'data-composer': '',
          'data-composer-input': '',
          'data-composer-agent': current.agentId,
          tabindex: current.disabled ? '-1' : '0',
        };
        if (current.sessionId !== undefined) attributes['data-composer-session'] = current.sessionId;
        if (current.autoFocus) attributes['data-autofocus'] = '';
        if (current.enterKeyHint !== undefined) attributes['enterkeyhint'] = current.enterKeyHint;
        return attributes;
      }),
    ];
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const references = StateField.define<DecorationSet>({
      create: (state) => referenceDecorations(state, labelsRef.current),
      update: (decorations, transaction) => transaction.docChanged || transaction.selection !== undefined || transaction.effects.some((effect) => effect.is(refreshReferences))
        ? referenceDecorations(transaction.state, labelsRef.current) : decorations,
      provide: (field) => [
        EditorView.decorations.from(field),
        EditorView.atomicRanges.of((view) => view.state.field(field)),
      ],
    });
    let composing = false;
    let compositionKey = false;
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: propsRef.current.value,
        extensions: [
          inputTheme, EditorView.lineWrapping, references,
          config.current.of(configuration()),
          EditorView.domEventHandlers({
            keydown: (event) => {
              compositionKey = composing || event.isComposing || event.keyCode === 229;
              if (compositionKey) return false;
              propsRef.current.onKeyDown(event);
              return event.defaultPrevented;
            },
            focus: () => { propsRef.current.onFocus(); },
            blur: () => { propsRef.current.onBlur(); },
            compositionstart: () => { composing = true; propsRef.current.onCompositionStart(); },
            compositionend: () => { composing = false; propsRef.current.onCompositionEnd(); },
            paste: (event) => {
              propsRef.current.onPaste(event);
              return event.defaultPrevented;
            },
          }),
          keymap.of(standardKeymap.map((binding) => ({
            ...binding,
            preventDefault: false,
            run: (view) => !compositionKey && (binding.key === 'Enter' ? insertNewline(view) : binding.run?.(view) ?? false),
            shift: binding.shift === undefined ? undefined : (view) => !compositionKey && (binding.key === 'Enter' ? insertNewline(view) : binding.shift!(view)),
          }))),
          EditorView.updateListener.of((update) => {
            if (externalChange.current) return;
            const current = propsRef.current;
            if (current.disabled) return;
            if (update.docChanged) current.onChange(update.state.sliceDoc(), update.state.selection.main.head);
            if (update.selectionSet || update.docChanged) current.onSelection(update.state.selection.main.head);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const handle: ComposerInputHandle = {
      element: view.contentDOM,
      get value() { return view.state.sliceDoc(); },
      get selectionStart() { return view.state.selection.main.from; },
      get selectionEnd() { return view.state.selection.main.to; },
      get selectionDirection() { return view.state.selection.main.anchor > view.state.selection.main.head ? 'backward' : 'forward'; },
      get disabled() { return view.state.readOnly; },
      focus: (options) => { view.contentDOM.focus(options); },
      setSelectionRange: (start, end, direction) => {
        const from = Math.max(0, Math.min(start, view.state.doc.length));
        const to = Math.max(0, Math.min(end, view.state.doc.length));
        view.dispatch({ selection: direction === 'backward' ? { anchor: to, head: from } : { anchor: from, head: to } });
      },
      setRangeText: (text, start = view.state.selection.main.from, end = view.state.selection.main.to, mode = 'preserve') => {
        const inserted = view.state.toText(text);
        const cursor = start + inserted.length;
        const selection = mode === 'select'
          ? { anchor: start, head: cursor }
          : { anchor: mode === 'start' ? start : cursor };
        view.dispatch({ changes: { from: start, to: end, insert: inserted }, selection, userEvent: 'input' });
      },
      setValueAndCursor: (value, cursor) => {
        const rawAt = Math.max(0, Math.min(cursor, value.length));
        const at = view.state.toText(value.slice(0, rawAt)).length;
        externalChange.current = true;
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: normalizeComposerText(value) },
            selection: { anchor: at },
            annotations: Transaction.addToHistory.of(false),
          });
        } finally {
          externalChange.current = false;
        }
      },
      select: () => { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); },
    };
    propsRef.current.inputRef.current = handle;
    const unregister = registerComposerInput(handle);
    return () => {
      unregister();
      view.destroy();
      viewRef.current = null;
      propsRef.current.inputRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const value = normalizeComposerText(props.value);
    if (view === null || view.composing || view.state.sliceDoc() === value) return;
    externalChange.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
    } finally {
      externalChange.current = false;
    }
  }, [props.value]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const focused = view.hasFocus;
    view.dispatch({ effects: config.current.reconfigure(configuration()) });
    if (props.disabled && focused) view.contentDOM.blur();
  }, [props.disabled, props.label, props.placeholder, props.sessionId, props.agentId, props.autoFocus, props.enterKeyHint]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view !== null && !view.composing) view.dispatch({ effects: refreshReferences.of(null) });
  }, [props.references]);

  return <div ref={containerRef} className="composer-input text-[14.5px] pointer-coarse:text-[16px]" />;
}
