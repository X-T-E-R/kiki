// @vitest-environment jsdom

/**
 * Shared settings controls: the self-saving field, the bare switch inside a
 * labelled row, the inline save states, and the quiet feedback line.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { FeedbackLine, SaveStatus, Toggle } from '../controls';
import { SettingField } from './fields';
import { CommitInput, SettingsDraftFooter } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';

let container: HTMLDivElement;
let root: Root;
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<I18nProvider>{node}</I18nProvider>); });
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CommitInput', () => {
  it('commits on blur, refuses invalid text with a field message, and restores on Escape', async () => {
    const commits: string[] = [];
    await render(<CommitInput value="10" ariaLabel="Budget" onCommit={(text) => { commits.push(text); }}
      validate={(text) => (/^\d+$/.test(text) ? null : 'Whole number')} />);
    const input = container.querySelector('input')!;
    await act(async () => { type(input, 'abc'); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(commits).toEqual([]);
    expect(container.querySelector('[data-field-issue]')?.textContent).toBe('Whole number');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(input.value).toBe('10');
    await act(async () => { type(input, ' 25 '); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(commits).toEqual(['25']);
    // Unchanged text never writes.
    await act(async () => { type(input, '10'); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(commits).toEqual(['25']);
  });
});

describe('Toggle bare layout', () => {
  it('prints the label once, in the row, while the switch keeps an accessible name', async () => {
    await render(<SettingField label="Use memory" help="Keeps preferences.">
      <Toggle layout="bare" label="Use memory" checked onChange={() => undefined} />
    </SettingField>);
    const visible = [...container.querySelectorAll('span')].filter((node) => node.textContent === 'Use memory' && !node.className.includes('sr-only'));
    expect(visible).toHaveLength(1);
    expect(container.querySelector('label')?.textContent).toBe('Use memory');
  });
});

describe('save feedback', () => {
  it('shows Saving… then ✓ Saved for an instant write, and an error line when it fails', async () => {
    let finish: (() => void) | undefined;
    function Harness({ fail }: { fail: boolean }) {
      const save = useInstantSave();
      return <div>
        <button type="button" onClick={() => void save.run(() => new Promise<void>((resolve, reject) => { finish = fail ? () => reject(new Error('Server said no')) : resolve; }))}>go</button>
        <SaveStatus saving={save.saving} saved={save.saved} />
        <FeedbackLine feedback={save.error} />
      </div>;
    }
    await render(<Harness fail={false} />);
    await act(async () => { container.querySelector('button')!.click(); });
    expect(container.querySelector('[data-save-status="saving"]')).not.toBeNull();
    await act(async () => { finish!(); });
    expect(container.querySelector('[data-saved-tick]')?.textContent).toBe('Saved');
    await act(async () => { root.render(<I18nProvider><Harness fail /></I18nProvider>); });
    await act(async () => { container.querySelector('button')!.click(); });
    await act(async () => { finish!(); });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Server said no');
    expect(alert.className).not.toContain('font-mono');
  });

  it('collapses a draft footer to a saved line after the save lands', async () => {
    function Harness() {
      const [dirty, setDirty] = useState(true);
      const [saved, setSaved] = useState(false);
      return <SettingsDraftFooter id="demo" dirty={dirty} saved={saved} onSave={() => { setDirty(false); setSaved(true); }} onDiscard={() => undefined} />;
    }
    await render(<Harness />);
    expect(container.querySelector('[data-settings-draft="demo"]')?.hasAttribute('hidden')).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-draft="demo"] button')!.click(); });
    expect(container.querySelector('[data-settings-draft="demo"]')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('[data-settings-draft-saved="demo"]')?.textContent).toBe('Saved');
  });
});
