import { useEffect, useRef } from 'react';
import { anyOverlayOpen } from './uiBusy';
import { composerInputOf } from './composerInput';

type Caret = { start: number; end: number; direction: 'forward' | 'backward' | 'none'; value: string };

function composerKey(node: HTMLElement): string {
  return `${node.dataset['composerSession']}\0${node.dataset['composerAgent'] ?? 'main'}`;
}

export function shouldYieldComposerFocus(active: Element | null): boolean {
  if (anyOverlayOpen()) return true;
  if (active === null || active === document.body) return false;
  if (active.closest('.xterm') !== null) return true;
  if (active.matches('[data-composer]')) return false;
  return active instanceof HTMLInputElement || active instanceof HTMLSelectElement ||
    active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

/** One focus request per conversation endpoint, consumed or cancelled by user focus. */
export function useNavigationComposerFocus(scopeId: string, sessionId: string | undefined, agentId = 'main'): void {
  const carets = useRef(new Map<string, Caret>());
  useEffect(() => {
    carets.current.clear();
    const remember = (event: Event) => {
      const node = event.target;
      const input = composerInputOf(node);
      if (!(node instanceof HTMLElement) || input === null || !node.matches('[data-composer-session]')) return;
      carets.current.set(composerKey(node), {
        start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, value: input.value,
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
      if (target instanceof Element && target.matches('[data-composer-session]')) return;
      cancel();
    };
    const attempt = () => {
      frame = 0;
      if (finished) return;
      if (shouldYieldComposerFocus(document.activeElement)) { cancel(); return; }
      const node = [...document.querySelectorAll<HTMLElement>('[data-composer-session]')]
        .find((element) => element.dataset['composerSession'] === sessionId && element.dataset['composerAgent'] === agentId);
      const input = composerInputOf(node ?? null);
      if (node === undefined || input === null || input.disabled || node.getClientRects().length === 0 || getComputedStyle(node).visibility === 'hidden') return;
      cancel();
      const caret = carets.current.get(composerKey(node));
      input.focus({ preventScroll: true });
      if (caret !== undefined && caret.value === input.value) input.setSelectionRange(caret.start, caret.end, caret.direction);
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
