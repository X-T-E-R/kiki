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
 */

import { useEffect, useRef } from 'react';

import { Compartment, EditorState } from '@codemirror/state';
import {
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

import { basenameOf } from '@kiki/session-core/composer/media';

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

export interface CodeEditorProps {
  /** Absolute path — the editor instance is keyed on it by the caller. */
  readonly path: string;
  /** Initial document; later external replacements ride `generation`. */
  readonly value: string;
  readonly generation: number;
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
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());

  // Construct once per path (the caller remounts via key).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
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
          languageCompartment.current.of([]),
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
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
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        ],
      }),
    });
    viewRef.current = view;

    // Lazy language load: matched by filename, swapped in when ready.
    const description = LanguageDescription.matchFilename(languages, basenameOf(path));
    let cancelled = false;
    if (description != null) {
      void Promise.resolve(description.load()).then((support) => {
        if (cancelled || viewRef.current !== view) return;
        view.dispatch({ effects: languageCompartment.current.reconfigure(support) });
      });
    }
    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // External document replacement (initial load, conflict reload).
  const appliedGenerationRef = useRef(-1);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || appliedGenerationRef.current === generation) return;
    appliedGenerationRef.current = generation;
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [generation, value]);

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
