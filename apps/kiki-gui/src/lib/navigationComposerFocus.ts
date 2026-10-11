import { useEffect, useRef } from 'react';
import { anyOverlayOpen } from './uiBusy';

type Caret = { start: number; end: number; direction: 'forward' | 'backward' | 'none'; value: string };

function composerKey(node: HTMLTextAreaElement): string {
  return `${node.dataset['composerSession']}\0${node.dataset['composerAgent'] ?? 'main'}`;
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
    if (sessionId === undefined || anyOverlayOpen() || document.activeElement?.closest('.xterm')) return;
    let finished = false;
    let frame = 0;
    const observer = new MutationObserver(() => schedule());
    const cancel = () => {
      finished = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', cancel, true);
    };
    const attempt = () => {
      frame = 0;
      if (finished) return;
      if (anyOverlayOpen() || document.activeElement?.closest('.xterm')) { cancel(); return; }
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
    document.addEventListener('focusin', cancel, true);
    schedule();
    return cancel;
  }, [scopeId, sessionId, agentId]);
}
