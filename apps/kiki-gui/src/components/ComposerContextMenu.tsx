/**
 * ComposerContextMenu — a custom right-click menu for the composer's native
 * textarea (cut / copy / paste-as-plain-text / select-all), modeled on
 * liveagent's NativeInputContextMenu with a codeg-style plain-text paste path.
 *
 * Behavior:
 *   - Replaces the native context menu when the async Clipboard API is usable
 *     (a secure context). When it is not, we let the browser's native menu
 *     through so its Paste keeps working over the editable text.
 *   - Cut / Copy are disabled when there is no non-empty selection.
 *   - Paste reads only `navigator.clipboard.readText()` and inserts verbatim;
 *     a failed read falls back to `document.execCommand('paste')`, and if that
 *     fails too, the native menu surface is gone so we do nothing further.
 *
 * The menu is wired to the textarea's onContextMenu only. The "blank chrome"
 * of the composer borders the textarea, but right-click target-less whitespace
 * is still the textarea's flow box in this layout (flex child), so the same
 * handler covers it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

import { useI18n } from '../i18n';

/** Whether the async Clipboard read API is present (secure context). */
export function clipboardReadSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator.clipboard?.readText) === 'function' &&
    typeof (navigator.clipboard?.writeText) === 'function'
  );
}

interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly start: number;
  readonly end: number;
  readonly hasSelection: boolean;
  /** The value at open time, used to pin the selection back onto the textarea. */
  readonly length: number;
}

/** Shared menu for one textarea: the anchor snapshots the selection so the
 * subsequent menu-clicks can restore it before running cut/copy/paste. */
export function useComposerContextMenu({
  textareaRef,
  onChange,
  onPastePlainText,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Controlled value setter — paste/cut must route through it so React re-renders. */
  onChange: (next: string) => void;
  /** Plain-text paste of an already-read clipboard string (integration seam + tests). */
  onPastePlainText?: (text: string) => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => { setAnchor(null); }, []);

  const [clipboardOk, setClipboardOk] = useState(false);
  useEffect(() => {
    // Resolved after mount so SSR (none here) and the first client render agree.
    setClipboardOk(clipboardReadSupported());
  }, []);

  // Clamp the menu against the viewport once its real size is known, before
  // first paint, so an out-of-bounds item can never fall outside the clickable
  // area and stall the walker / user.
  useLayoutEffect(() => {
    if (anchor === null) return;
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const margin = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - rect.height);
    }
    if (left !== anchor.x || top !== anchor.y) {
      setAnchor({ ...anchor, x: left, y: top });
    }
  }, [anchor]);

  // Dismiss on outside pointer / any key / scroll / resize / window blur.
  useEffect(() => {
    if (anchor === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Escape only dismisses the menu, never a host dialog / abort.
      if (event.key === 'Escape') event.stopPropagation();
      closeMenu();
    };
    const onScroll = () => { closeMenu(); };
    const onResize = () => { closeMenu(); };
    const onBlur = () => { closeMenu(); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    };
  }, [anchor, closeMenu]);

  /** Re-pin the captured selection and focus so browser/execCommand act on the
   * range the user right-clicked (async clipboard reads can shift focus). */
  const restoreSelection = useCallback((): HTMLTextAreaElement | null => {
    const el = textareaRef.current;
    if (el === null || anchor === null) return null;
    el.focus({ preventScroll: true });
    try {
      el.setSelectionRange(anchor.start, anchor.end);
    } catch {
      // Selection API unsupported; the browser caret still anchors the op.
    }
    return el;
  }, [textareaRef, anchor]);

  const replaceRange = useCallback(() => {
    const el = textareaRef.current;
    if (el === null || anchor === null) return false;
    // setRangeText by itself does not fire an input event — dispatch one so the
    // controlled textarea's React onChange climbs back into the parent.
    el.setRangeText('');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, [textareaRef, anchor]);

  const readClipboard = async (): Promise<string> => {
    if (typeof navigator.clipboard?.readText === 'function') {
      try {
        return (await navigator.clipboard.readText()) ?? '';
      } catch {
        // denied / no activation — fall through to the native command.
      }
    }
    return fallbackReadClipboard();
  };

  /** Exec-command fallback: `paste` writes into the currently-selected range. */
  const fallbackReadClipboard = (): string => {
    const el = textareaRef.current;
    if (el === null) return '';
    const before = el.value;
    let ok = false;
    try {
      ok = document.execCommand('paste');
    } catch {
      ok = false;
    }
    // execCommand paste is synchronous: success deselects too, so commit to
    // React immediately. A failed fallback leaves the value untouched.
    if (ok) {
      const next = el.value;
      onChange(next);
      return next.slice(before.length);
    }
    return '';
  };

  const handleCopy = useCallback(() => {
    const el = textareaRef.current;
    if (el !== null && anchor !== null && typeof navigator.clipboard?.writeText === 'function') {
      void navigator.clipboard
        .writeText(el.value.slice(anchor.start, anchor.end))
        .catch(() => {
          copyFallback(el.value.slice(anchor.start, anchor.end));
        });
    } else if (el !== null && anchor !== null) {
      copyFallback(el.value.slice(anchor.start, anchor.end));
    }
    closeMenu();
  }, [textareaRef, anchor, closeMenu]);

  const handleCut = useCallback(() => {
    const el = restoreSelection();
    if (el === null || anchor === null || !anchor.hasSelection) {
      closeMenu();
      return;
    }
    const text = el.value.slice(anchor.start, anchor.end);
    const writeClipboard = (piece: string) => {
      if (typeof navigator.clipboard?.writeText === 'function') {
        void navigator.clipboard.writeText(piece).catch(() => { copyFallback(piece); });
      } else {
        copyFallback(piece);
      }
    };
    writeClipboard(text);
    replaceRange();
    closeMenu();
  }, [restoreSelection, replaceRange, anchor, closeMenu]);

  const handlePaste = useCallback(async () => {
    if (anchor === null) return;
    const text = await readClipboard();
    const el = restoreSelection();
    if (el === null) {
      closeMenu();
      return;
    }
    if (text !== '') {
      if (onPastePlainText !== undefined) {
        onPastePlainText(text);
      } else {
        // Insert around the pinned range; the input event keeps the textarea
        // controlled and `onChange` climbs back into the parent.
        el.setRangeText(text, anchor.start, anchor.end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    closeMenu();
  }, [anchor, closeMenu, readClipboard, restoreSelection, onPastePlainText]);

  const handleSelectAll = useCallback(() => {
    const el = restoreSelection();
    el?.select();
    closeMenu();
  }, [restoreSelection, closeMenu]);

  const onContextMenu = (event: MouseEvent<HTMLTextAreaElement>) => {
    // Without the clipboard API the native menu is the only working Paste —
    // let it through instead of showing a menu whose paste can do nothing.
    if (!clipboardOk) return;
    event.preventDefault();
    const el = event.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    setAnchor({
      x: event.clientX,
      y: event.clientY,
      start,
      end,
      hasSelection: end > start,
      length: el.value.length,
    });
  };

  const menu =
    anchor === null ? null : (
      <div
        ref={menuRef}
        role="menu"
        data-composer-context-menu
        aria-label={t('composer.contextMenuAria')}
        onContextMenu={(event) => { event.preventDefault(); }}
        className="fixed z-[100] min-w-40 select-none overflow-hidden rounded-lg border border-hairline bg-panel p-1 shadow-[0_20px_60px_-20px_rgba(28,25,23,0.35)]"
        style={{ left: anchor.x, top: anchor.y }}
      >
        <button
          type="button"
          role="menuitem"
          data-menu-action="cut"
          disabled={!anchor.hasSelection}
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={handleCut}
          className={MENU_ITEM_CLASS}
        >
          {t('contextMenu.cut')}
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-action="copy"
          disabled={!anchor.hasSelection}
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={handleCopy}
          className={MENU_ITEM_CLASS}
        >
          {t('contextMenu.copy')}
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-action="paste"
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={() => { void handlePaste(); }}
          className={MENU_ITEM_CLASS}
        >
          {t('contextMenu.paste')}
        </button>
        <div className="my-1 h-px bg-hairline" />
        <button
          type="button"
          role="menuitem"
          data-menu-action="select-all"
          disabled={anchor.length === 0}
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={handleSelectAll}
          className={MENU_ITEM_CLASS}
        >
          {t('contextMenu.selectAll')}
        </button>
      </div>
    );

  return { onContextMenu, menu };
}

const MENU_ITEM_CLASS =
  'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper disabled:pointer-events-none disabled:opacity-45';

/** Hidden-textarea fallback write for non-secure contexts or write denial. */
function copyFallback(text: string) {
  if (text === '') return;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // nothing left to fall back to — copy simply no-ops
  }
  document.body.removeChild(textarea);
}