import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';

import { markInteractiveInputActive } from '@kiki/session-core/session';

import { normalizeComposerText, registerComposerInput, type ComposerInputHandle } from '../lib/composerInput';
import { useMediaQuery, usePhoneMode } from '../lib/layoutHooks';
import type { ComposerInputProps } from './ComposerCodeMirror';

export type { ComposerInputProps, ComposerReferenceLabel, ComposerSkillSpan } from './ComposerCodeMirror';

type CodeMirrorComponent = ComponentType<ComposerInputProps>;

let loadedCodeMirror: CodeMirrorComponent | null = null;
let codeMirrorLoadPromise: Promise<CodeMirrorComponent> | null = null;

/** Test seam: synchronously populate CodeMirror so jsdom suites that inspect EditorView immediately work. */
export function registerComposerCodeMirror(impl: CodeMirrorComponent): void {
  loadedCodeMirror = impl;
}

function loadComposerCodeMirror(): Promise<CodeMirrorComponent> {
  if (loadedCodeMirror !== null) return Promise.resolve(loadedCodeMirror);
  codeMirrorLoadPromise ??= import('./ComposerCodeMirror').then((mod) => {
    loadedCodeMirror = mod.ComposerCodeMirror;
    return mod.ComposerCodeMirror;
  });
  return codeMirrorLoadPromise;
}

interface PendingUpgradeFocus {
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none';
}

export function ComposerInput(props: ComposerInputProps) {
  const isPhone = usePhoneMode() || useMediaQuery('(max-width: 767px)');
  const [activated, setActivated] = useState(false);
  const [editorReady, setEditorReady] = useState(() => loadedCodeMirror !== null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocusRef = useRef<PendingUpgradeFocus | null>(null);
  const programmaticFocusRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const hasRichContent =
    props.value !== ''
    || props.references.length > 0
    || (props.skillSpans?.length ?? 0) > 0
    || (!isPhone && props.autoFocus === true);
  const deferLoad = isPhone && !activated && !hasRichContent;

  useEffect(() => {
    if (deferLoad || loadedCodeMirror !== null) return;
    let active = true;
    void loadComposerCodeMirror().then(() => {
      if (active) setEditorReady(true);
    });
    return () => {
      active = false;
    };
  }, [deferLoad]);

  const useCodeMirror = !deferLoad && editorReady && loadedCodeMirror !== null;

  useLayoutEffect(() => {
    if (!useCodeMirror) return;
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    pendingFocusRef.current = null;
    const handle = propsRef.current.inputRef.current;
    if (handle === null) return;
    handle.focus({ preventScroll: true });
    handle.setSelectionRange(pending.start, pending.end, pending.direction);
  }, [useCodeMirror]);

  useLayoutEffect(() => {
    if (useCodeMirror) return;
    const el = textareaRef.current;
    if (el === null) return;
    const handle: ComposerInputHandle = {
      element: el,
      get value() { return el.value; },
      get selectionStart() { return el.selectionStart ?? 0; },
      get selectionEnd() { return el.selectionEnd ?? 0; },
      get selectionDirection() { return el.selectionDirection ?? 'none'; },
      get disabled() { return el.disabled; },
      focus: (options) => {
        programmaticFocusRef.current = true;
        try {
          el.focus(options);
        } finally {
          programmaticFocusRef.current = false;
        }
        if (!isPhone) setActivated(true);
      },
      setSelectionRange: (start, end, direction) => {
        el.setSelectionRange(start, end, direction);
      },
      setRangeText: (text, start = el.selectionStart ?? 0, end = el.selectionEnd ?? 0, mode = 'preserve') => {
        el.setRangeText(text, start, end, mode);
        propsRef.current.onChange(el.value, el.selectionEnd ?? el.value.length);
      },
      setValueAndCursor: (value, cursor) => {
        const normalized = normalizeComposerText(value);
        const at = Math.max(0, Math.min(cursor, normalized.length));
        el.value = normalized;
        el.setSelectionRange(at, at);
      },
      select: () => { el.select(); },
    };
    propsRef.current.inputRef.current = handle;
    const unregister = registerComposerInput(handle);
    return () => {
      unregister();
      if (propsRef.current.inputRef.current === handle) {
        propsRef.current.inputRef.current = null;
      }
    };
  }, [useCodeMirror]);

  if (useCodeMirror) {
    const Editor = loadedCodeMirror!;
    return <Editor {...props} />;
  }

  const triggerUpgrade = (captureFocus: boolean) => {
    if (captureFocus && textareaRef.current !== null) {
      pendingFocusRef.current = {
        start: textareaRef.current.selectionStart ?? props.value.length,
        end: textareaRef.current.selectionEnd ?? props.value.length,
        direction: textareaRef.current.selectionDirection ?? 'none',
      };
    }
    if (!activated) setActivated(true);
  };

  return (
    <div className="composer-input text-[length:var(--kiki-prose-font-size,14.5px)] pointer-coarse:text-[length:max(16px,var(--kiki-prose-font-size,14.5px))]">
      <textarea
        ref={textareaRef}
        rows={1}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        aria-multiline="true"
        aria-disabled={props.disabled}
        placeholder={props.placeholder}
        enterKeyHint={props.enterKeyHint as 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | undefined}
        data-composer=""
        data-composer-input=""
        data-composer-agent={props.agentId}
        data-composer-session={props.sessionId}
        data-autofocus={props.autoFocus ? '' : undefined}
        className="w-full resize-none bg-transparent text-ink placeholder:text-ink-faint outline-none py-[2px] min-h-[28px] max-h-[190px] leading-[1.625] overflow-auto block"
        onPointerDown={() => { triggerUpgrade(false); }}
        onFocus={() => {
          if (!isPhone) triggerUpgrade(true);
          props.onFocus();
        }}
        onBlur={() => {
          pendingFocusRef.current = null;
          props.onBlur();
        }}
        onChange={(event) => {
          markInteractiveInputActive(160);
          triggerUpgrade(true);
          props.onChange(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => {
          const target = event.currentTarget;
          if (pendingFocusRef.current !== null) {
            pendingFocusRef.current = {
              start: target.selectionStart ?? 0,
              end: target.selectionEnd ?? 0,
              direction: target.selectionDirection ?? 'none',
            };
          }
          props.onSelection(target.selectionStart ?? 0);
        }}
        onKeyDown={(event) => {
          markInteractiveInputActive(160);
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          triggerUpgrade(true);
          props.onKeyDown(event.nativeEvent);
        }}
        onCompositionStart={() => { props.onCompositionStart(); }}
        onCompositionEnd={() => { props.onCompositionEnd(); }}
        onPaste={(event) => {
          triggerUpgrade(true);
          props.onPaste(event.nativeEvent);
        }}
      />
    </div>
  );
}
