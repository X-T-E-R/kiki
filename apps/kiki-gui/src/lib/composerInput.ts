export type ComposerSelectionDirection = 'forward' | 'backward' | 'none';

/** The composer's raw-document editing seam, independent of its rendered labels. */
export interface ComposerInputHandle {
  readonly element: HTMLElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: ComposerSelectionDirection;
  readonly disabled: boolean;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number, direction?: ComposerSelectionDirection): void;
  setRangeText(text: string, start?: number, end?: number, mode?: SelectionMode): void;
  setValueAndCursor(value: string, cursor: number): void;
  select(): void;
}

const inputs = new WeakMap<HTMLElement, ComposerInputHandle>();

export function registerComposerInput(input: ComposerInputHandle): () => void {
  inputs.set(input.element, input);
  return () => { inputs.delete(input.element); };
}

export function composerInputOf(node: EventTarget | null): ComposerInputHandle | HTMLTextAreaElement | null {
  if (node instanceof HTMLTextAreaElement && node.matches('[data-composer]')) return node;
  return node instanceof HTMLElement ? inputs.get(node) ?? null : null;
}

export function composerInputElement(input: ComposerInputHandle | HTMLTextAreaElement): HTMLElement {
  return input instanceof HTMLTextAreaElement ? input : input.element;
}
