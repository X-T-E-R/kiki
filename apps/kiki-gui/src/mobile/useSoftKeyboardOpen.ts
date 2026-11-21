import { useEffect, useState, type RefObject } from 'react';

const KEYBOARD_VIEWPORT_DELTA = 120;

function isEditable(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !element.disabled && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * True while a text field inside `root` has focus on a touch device, or while
 * the visual viewport has visibly shrunk under a soft keyboard.
 */
export function useSoftKeyboardOpen(root: RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    const viewport = window.visualViewport;
    const update = () => {
      const active = document.activeElement;
      const focusedInside = isEditable(active) && root.current?.contains(active) === true;
      const shrunk = viewport !== null && window.innerHeight - viewport.height > KEYBOARD_VIEWPORT_DELTA;
      setOpen(focusedInside && ((coarse?.matches ?? false) || shrunk));
    };
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    viewport?.addEventListener('resize', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      viewport?.removeEventListener('resize', update);
    };
  }, [root]);

  return open;
}
