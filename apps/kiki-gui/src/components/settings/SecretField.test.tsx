// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecretSource } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';

const clipboard = vi.hoisted(() => ({ copyTextToClipboard: vi.fn(async (_text: string) => undefined) }));
vi.mock('../../lib/clipboard', () => clipboard);

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let root: Root;
let container: HTMLDivElement;
let changes: SecretDraft[];

beforeEach(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  clipboard.copyTextToClipboard.mockClear();
  changes = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function Harness({ source, envName, reveal, initial = KEEP_SECRET, clearable }: {
  source: SecretSource;
  envName?: string;
  reveal?: () => Promise<string | undefined>;
  initial?: SecretDraft;
  clearable?: boolean;
}) {
  const [draft, setDraft] = useState<SecretDraft>(initial);
  return (
    <SecretField label="API key" source={source} envName={envName} draft={draft} reveal={reveal} clearable={clearable}
      onChange={(next) => { changes.push(next); setDraft(next); }} />
  );
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => { root.render(<I18nProvider><Harness {...props} /></I18nProvider>); });
}
const input = () => container.querySelector<HTMLInputElement>('input')!;
const byData = (name: string) => container.querySelector<HTMLButtonElement>(`[data-secret-${name}]`);
async function click(element: Element | null) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); });
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SecretField', () => {
  it('masks a saved value and fetches it only when the eye is pressed', async () => {
    const reveal = vi.fn(async () => 'sk-fixture-saved');
    await render({ source: 'kiki', reveal });
    expect(input().value).not.toContain('sk-fixture');
    expect(input().readOnly).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Saved in Kiki');

    await click(byData('reveal'));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('sk-fixture-saved');
    expect(byData('reveal')!.getAttribute('aria-pressed')).toBe('true');

    await click(byData('reveal'));
    expect(input().value).not.toContain('sk-fixture');
    // A second show reuses the fetched copy rather than asking the server again.
    await click(byData('reveal'));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('shows an environment source by name and edits it as an override saved in Kiki', async () => {
    const reveal = vi.fn(async () => 'sk-fixture-env');
    await render({ source: 'environment', envName: 'FIXTURE_API_KEY', reveal });
    expect(container.textContent).toContain('From environment variable FIXTURE_API_KEY');
    expect(container.querySelector('code')?.textContent).toBe('FIXTURE_API_KEY');
    // An env value is viewable too, and cannot be cleared from Kiki.
    await click(byData('reveal'));
    expect(input().value).toBe('sk-fixture-env');
    expect(byData('clear')).toBeNull();

    await click(byData('edit'));
    expect(byData('edit')).toBeNull();
    expect(changes.at(-1)).toEqual({ mode: 'set', value: 'sk-fixture-env' });
    await type('sk-fixture-override');
    expect(changes.at(-1)).toEqual({ mode: 'set', value: 'sk-fixture-override' });
    expect(container.textContent).toContain('Saving stores this value in Kiki and uses it instead');

    await click(byData('cancel'));
    expect(changes.at(-1)).toEqual(KEEP_SECRET);
  });

  it('copies the revealed value without displaying it', async () => {
    const reveal = vi.fn(async () => 'sk-fixture-copy');
    await render({ source: 'kiki', reveal });
    await click(byData('copy'));
    await act(async () => { await Promise.resolve(); });
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith('sk-fixture-copy');
    expect(input().value).not.toContain('sk-fixture');
    expect(container.textContent).toContain('Copied');
  });

  it('marks a clear as pending and lets the user undo it before saving', async () => {
    await render({ source: 'kiki', reveal: async () => 'sk-fixture' });
    await click(byData('clear'));
    expect(changes.at(-1)).toEqual({ mode: 'clear' });
    expect(input().disabled).toBe(true);
    expect(container.textContent).toContain('Will be removed when you save');
    expect(byData('reveal')!.disabled).toBe(true);
    await click(byData('undo'));
    expect(changes.at(-1)).toEqual(KEEP_SECRET);
  });

  it('starts as a plain masked input when nothing is stored', async () => {
    await render({ source: 'none' });
    expect(container.textContent).toContain('Not set');
    expect(input().readOnly).toBe(false);
    expect(input().type).toBe('password');
    expect(byData('reveal')!.disabled).toBe(true);
    await type('sk-new');
    expect(changes.at(-1)).toEqual({ mode: 'set', value: 'sk-new' });
    await click(byData('reveal'));
    expect(input().type).toBe('text');
    // Emptying a new value returns to "keep" so an untouched field sends nothing.
    await type('');
    expect(changes.at(-1)).toEqual(KEEP_SECRET);
  });

  it('reports a failed reveal without showing any value', async () => {
    await render({ source: 'kiki', reveal: async () => { throw new Error('fixture reveal failed'); } });
    await click(byData('reveal'));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load the value');
    expect(container.textContent).not.toContain('fixture reveal failed');
    expect(byData('reveal')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('labels every icon control with the field name', async () => {
    await render({ source: 'kiki', reveal: async () => 'x' });
    expect(byData('reveal')!.getAttribute('aria-label')).toBe('Show API key');
    expect(byData('copy')!.getAttribute('aria-label')).toBe('Copy API key');
    expect(container.querySelector('label')!.htmlFor).toBe(input().id);
  });
});
