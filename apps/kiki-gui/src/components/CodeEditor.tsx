/**
 * CodeEditor — thin React wrapper over a CodeMirror 6 EditorView for the
 * preview workspace. One editor instance per mounted tab (the workspace keeps
 * every tab's view mounted, hidden when inactive, so undo history and scroll
 * position survive tab switches).
 *
 * The value flow is deliberately one-directional: user edits leave through
 * `onChange`, and the document is only overwritten externally when
 * `generation` changes (initial load, conflict reload) — never on every
 * keystroke echo, which would reset the cursor. Languages resolve from
 * @codemirror/language-data by filename and load lazily; Mod-S is bound to
 * `onSaveShortcut`. Read-only mode (browser build / oversized files / image
 * fallbacks) shares the same highlighting path.
 *
 * Line breaks are saved bytes. A file that uses only `\n`, only `\r\n`, or
 * only `\r` sets CodeMirror's `lineSeparator` to that break, so `sliceDoc()`
 * and newly inserted breaks round-trip it. A file that mixes breaks keeps
 * CodeMirror's logical lines (every break is still its own line). `onChange`
 * then reapplies the breaks outside the edited span, and reports the loaded
 * bytes again when the logical lines match them. External replacement is a
 * remote transaction and does not call `onChange`; neither does a read-only
 * view. An untouched buffer therefore stays equal to the loaded bytes, and
 * saving it cannot rewrite line breaks or look like an external conflict.
 */

import { useEffect, useRef } from 'react';

import { type Extension, Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  type ViewUpdate,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches } from '@codemirror/search';

import { basenameOf, type FileReference } from '@kiki/session-core/composer/media';

/** Kiki-palette chrome: paper surface, hairline gutters, accent caret. */
const KIKI_THEME = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-ink)',
    fontSize: '12px',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '8px 0',
    caretColor: 'var(--color-accent)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-ink-faint)',
    border: 'none',
    borderRight: '1px solid var(--color-hairline)',
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-ink-soft)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
});

const LINE_BREAK = /\r\n|\r|\n/g;

type UniformLineBreak = '\n' | '\r\n' | '\r';

/** The file's only break, or `\n` when it has none. Mixed files return none. */
function uniformLineBreak(text: string): UniformLineBreak | undefined {
  let kind: UniformLineBreak | undefined;
  for (const match of text.matchAll(LINE_BREAK)) {
    const found = match[0] as UniformLineBreak;
    if (kind === undefined) kind = found;
    else if (kind !== found) return undefined;
  }
  return kind ?? '\n';
}

function logicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function sameLogicalLines(left: string, right: string): boolean {
  const a = logicalLines(left);
  const b = logicalLines(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Rejoin `edited` (CodeMirror's logical lines) with the breaks in `baseline`.
 * Lines outside one edited span keep their original break. A new break uses
 * the break at the start of that span, or the file's first break.
 */
function projectLineEndings(edited: string, baseline: string): string {
  if (edited === baseline || sameLogicalLines(edited, baseline)) return baseline;
  const next = logicalLines(edited);
  const prev = logicalLines(baseline);
  const separators = baseline.match(/\r\n|\r|\n/g) ?? [];
  let prefix = 0;
  while (prefix < next.length && prefix < prev.length && next[prefix] === prev[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < next.length - prefix &&
    suffix < prev.length - prefix &&
    next[next.length - 1 - suffix] === prev[prev.length - 1 - suffix]
  ) suffix += 1;
  const insertedBreak = (prefix > 0 ? separators[prefix - 1] : undefined) ?? separators[0] ?? '\n';
  const suffixStart = next.length - suffix;
  let out = '';
  for (let i = 0; i < next.length; i += 1) {
    if (i > 0) {
      if (i < prefix) out += separators[i - 1] ?? insertedBreak;
      else if (i >= suffixStart) {
        const prevIndex = prev.length - (next.length - i);
        out += separators[prevIndex - 1] ?? insertedBreak;
      } else out += insertedBreak;
    }
    out += next[i] ?? '';
  }
  return out;
}

function textFromUserEdit(state: EditorState, external: string, emitted: string): string {
  const current = state.sliceDoc();
  if (current === external || sameLogicalLines(current, external)) return external;
  const kind = uniformLineBreak(emitted);
  if (kind !== undefined && state.facet(EditorState.lineSeparator) === kind) return current;
  const projected = projectLineEndings(current, emitted);
  return sameLogicalLines(projected, external) ? external : projected;
}

function documentMatches(state: EditorState, text: string): boolean {
  const current = state.sliceDoc();
  if (current === text) return true;
  return uniformLineBreak(text) === undefined && sameLogicalLines(current, text);
}

export interface CodeEditorProps {
  /** Absolute path — the editor instance is keyed on it by the caller. */
  readonly path: string;
  /** Initial document; later external replacements ride `generation`. */
  readonly value: string;
  readonly generation: number;
  readonly navigation?: FileReference;
  readonly readOnly: boolean;
  readonly onChange: (text: string) => void;
  /** Mod-S inside the editor. */
  readonly onSaveShortcut?: () => void;
  readonly ariaLabel: string;
}

export function CodeEditor({
  path,
  value,
  generation,
  navigation,
  readOnly,
  onChange,
  onSaveShortcut,
  ariaLabel,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Callbacks through refs: the update listener closes over them once at
  // construction, so parent re-renders never rebuild the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSaveShortcut);
  onSaveRef.current = onSaveShortcut;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const ariaLabelRef = useRef(ariaLabel);
  ariaLabelRef.current = ariaLabel;
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const languageExtensionRef = useRef<Extension>([]);
  // Loaded bytes, and the last string reported to the host (starts equal).
  const externalTextRef = useRef(value);
  const emittedTextRef = useRef(value);
  const appliedGenerationRef = useRef(-1);

  const extensionsFor = (text: string): Extension => {
    const kind = uniformLineBreak(text);
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      KIKI_THEME,
      kind === undefined ? [] : EditorState.lineSeparator.of(kind),
      languageCompartment.current.of(languageExtensionRef.current),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(readOnlyRef.current),
        EditorView.editable.of(!readOnlyRef.current),
      ]),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.docChanged || readOnlyRef.current) return;
        const userEdited = update.transactions.some((transaction) => (
          transaction.docChanged && transaction.annotation(Transaction.remote) !== true
        ));
        if (!userEdited) return;
        const next = textFromUserEdit(update.state, externalTextRef.current, emittedTextRef.current);
        if (next === emittedTextRef.current) return;
        emittedTextRef.current = next;
        onChangeRef.current(next);
      }),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabelRef.current }),
    ];
  };

  const stateFor = (text: string): EditorState => EditorState.create({
    doc: text,
    extensions: extensionsFor(text),
  });

  // Construct once per path (the caller remounts via key).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    appliedGenerationRef.current = -1;
    externalTextRef.current = value;
    emittedTextRef.current = value;
    const view = new EditorView({
      parent: container,
      state: stateFor(value),
    });
    viewRef.current = view;

    // Lazy language load: matched by filename, swapped in when ready.
    const description = LanguageDescription.matchFilename(languages, basenameOf(path));
    let cancelled = false;
    if (description !== null && description !== undefined) {
      void Promise.resolve(description.load()).then((support) => {
        if (cancelled || viewRef.current !== view) return;
        languageExtensionRef.current = support;
        view.dispatch({ effects: languageCompartment.current.reconfigure(support) });
      });
    }
    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // The view is rebuilt only when the path changes. Later bytes arrive
    // through `generation`; callbacks are read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // External document replacement (initial load, conflict reload).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || appliedGenerationRef.current === generation) return;
    appliedGenerationRef.current = generation;
    externalTextRef.current = value;
    emittedTextRef.current = value;
    if (view.state.facet(EditorState.lineSeparator) !== uniformLineBreak(value)) {
      // lineSeparator is static, so a different break style needs a new state.
      view.setState(stateFor(value));
      return;
    }
    if (!documentMatches(view.state, value)) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      });
    }
    // `stateFor` closes over refs; the bytes and the generation are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, value]);

  const appliedNavigationRef = useRef<FileReference | undefined>(undefined);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || navigation?.line === undefined || appliedNavigationRef.current === navigation) return;
    appliedNavigationRef.current = navigation;
    const line = view.state.doc.line(Math.max(1, Math.min(navigation.line, view.state.doc.lines)));
    const anchor = Math.min(line.to, line.from + Math.max(0, (navigation.column ?? 1) - 1));
    const head = navigation.endLine === undefined ? anchor : view.state.doc.line(Math.max(line.number, Math.min(navigation.endLine, view.state.doc.lines))).to;
    view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    view.focus();
  }, [navigation, generation]);

  // Read-only flips without a rebuild.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div ref={containerRef} data-code-editor={path} className="min-h-0 flex-1 overflow-hidden" />;
}
