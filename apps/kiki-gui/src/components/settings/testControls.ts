/**
 * Test helpers for the shared settings controls (jsdom). Kept next to the
 * primitives so every settings test opens and picks the same way.
 */

import { act } from 'react';

/** The trigger inside a `SettingsSelect` wrapper, a `#id`, or the trigger itself. */
function triggerOf(target: Element): HTMLButtonElement {
  if (target instanceof HTMLButtonElement && target.getAttribute('aria-haspopup') === 'listbox') return target;
  const trigger = target.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  if (trigger === null) throw new Error('no select trigger inside target');
  return trigger;
}

/** Current trigger text of a select. */
export function selectText(target: Element): string {
  return triggerOf(target).textContent?.trim() ?? '';
}

/**
 * Opens a select and commits the option whose label (or title) matches. The
 * listbox renders inside the select root, so the search is local.
 */
export async function pickOption(target: Element, label: string | RegExp): Promise<void> {
  const trigger = triggerOf(target);
  await act(async () => { trigger.click(); });
  const root = trigger.closest('[data-searchable-select]') ?? document.body;
  const options = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const matches = (text: string | null | undefined) =>
    text !== null && text !== undefined && (typeof label === 'string' ? text.trim() === label || text.includes(label) : label.test(text));
  const option = options.find((row) => matches(row.getAttribute('title')) || matches(row.textContent));
  if (option === undefined) {
    throw new Error(`no option ${String(label)} in [${options.map((row) => row.textContent).join(' | ')}]`);
  }
  await act(async () => { option.click(); });
}

/** Opens a select, reads every option label in order, and closes it again. */
export async function optionLabels(target: Element): Promise<string[]> {
  const trigger = triggerOf(target);
  await act(async () => { trigger.click(); });
  const root = trigger.closest('[data-searchable-select]') ?? document.body;
  const labels = [...root.querySelectorAll('[role="option"]')].map((row) => row.getAttribute('title') ?? row.textContent ?? '');
  await act(async () => { trigger.click(); });
  return labels;
}

/** Picks the option whose value (not label) matches. */
export async function pickValue(target: Element, _attr: string, value: string): Promise<void> {
  const trigger = triggerOf(target);
  await act(async () => { trigger.click(); });
  const root = trigger.closest('[data-searchable-select]') ?? document.body;
  const option = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) => row.getAttribute('data-option-value') === value);
  if (option === undefined) throw new Error(`no option with value ${value}`);
  await act(async () => { option.click(); });
}

/** Types into a `CommitInput` and commits with Enter. */
export async function commitText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

/** Opens a select, reads every option value in order, and closes it again. */
export async function optionValues(target: Element): Promise<string[]> {
  const trigger = triggerOf(target);
  await act(async () => { trigger.click(); });
  const root = trigger.closest('[data-searchable-select]') ?? document.body;
  const values = [...root.querySelectorAll('[role="option"]')].map((row) => row.getAttribute('data-option-value') ?? '');
  await act(async () => { trigger.click(); });
  return values;
}
