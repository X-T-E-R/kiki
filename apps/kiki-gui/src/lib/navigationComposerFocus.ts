import { useEffect, useRef } from 'react';
import { anyOverlayOpen } from './uiBusy';

type Caret = { start: number; end: number; direction: 'forward' | 'backward' | 'none'; value: string };

function composerKey(node: HTMLTextAreaElement): string {
  return `${node.dataset['composerSession']}\0${node.dataset['composerAgent'] ?? 'main'}`;
}

export function shouldYieldComposerFocus(active: Element | null): boolean {
  if (anyOverlayOpen()) return true;
  if (active === null || active === document.body) return false;
  if (active.closest('.xterm') !== null) return true;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable) ||
    (active instanceof HTMLTextAreaElement && !active.matches('textarea[data-composer], textarea[data-composer-session]'))
  ) {
    return true;
  }
  return false;
}

/** One focus request per conversation endpoint, consumed or cancelled by user focus. */
export function useNavigationComposerFocus(scopeId: string, sessionId: string | undefined, agentId = 'main'): void {
  const carets = useRef(new Map<string, Caret>());
  useEffect(() => {
    carets.current.clear();
    const remember = (event: Event) => {
      const node = event.target;
      if (!(node instanceof HTMLTextAreaElement) || !node.matches('[data-composer-session]')) return;
      carets.current.set(composerKey(node), {
        start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, value: node.value,
      });
    };
    for (const type of ['select', 'keyup', 'keydown', 'focusout']) document.addEventListener(type, remember, true);
    return () => {
      for (const type of ['select', 'keyup', 'keydown', 'focusout']) document.removeEventListener(type, remember, true);
    };
  }, [scopeId]);

  useEffect(() => {
    if (sessionId === undefined || shouldYieldComposerFocus(document.activeElement)) return;
    let finished = false;
    let frame = 0;
    const observer = new MutationObserver(() => schedule());
    const cancel = () => {
      finished = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', onFocusIn, true);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches('textarea[data-composer-session]')) return;
      cancel();
    };
    const attempt = () => {
      frame = 0;
      if (finished) return;
      if (shouldYieldComposerFocus(document.activeElement)) { cancel(); return; }
      const node = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-composer-session]')]
        .find((element) => element.dataset['composerSession'] === sessionId && element.dataset['composerAgent'] === agentId);
      if (node === undefined || node.disabled || node.getClientRects().length === 0 || getComputedStyle(node).visibility === 'hidden') return;
      cancel();
      const caret = carets.current.get(composerKey(node));
      node.focus({ preventScroll: true });
      if (caret !== undefined && caret.value === node.value) node.setSelectionRange(caret.start, caret.end, caret.direction);
    };
    function schedule() {
      if (!finished && frame === 0) frame = requestAnimationFrame(attempt);
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    document.addEventListener('focusin', onFocusIn, true);
    schedule();
    return cancel;
  }, [scopeId, sessionId, agentId]);
}
