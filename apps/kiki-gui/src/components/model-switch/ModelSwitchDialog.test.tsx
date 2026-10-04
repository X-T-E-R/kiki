// @vitest-environment jsdom

/**
 * The three-way confirm: vertical radio rows with their consequence line, the
 * remember checkbox with its scope caption, and a same-model entry that only
 * offers the two context-renewing modes (a direct switch onto the bound model
 * changes nothing).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ModelSwitchDialog } from './ModelSwitchDialog';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function renderDialog(
  props: Partial<Parameters<typeof ModelSwitchDialog>[0]> = {},
): Promise<{ container: HTMLElement; root: Root; onConfirm: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelSwitchDialog
          open
          fromModel="example/old"
          toModel="example/new"
          initialMode="direct"
          onConfirm={onConfirm}
          onCancel={onCancel}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return { container, root, onConfirm, onCancel };
}

function modeRow(container: HTMLElement, mode: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-model-switch-mode="${mode}"]`)!;
}

describe('ModelSwitchDialog', () => {
  it('offers the three modes with their consequence lines and names both models', async () => {
    const { container } = await renderDialog();
    expect(container.textContent).toContain('Switch to example/new');
    expect(container.textContent).toContain('Currently using example/old');
    expect(modeRow(container, 'direct').getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('example/new picks up the current context as-is.');
    expect(container.textContent).toContain('example/old writes a conversation summary for example/new');
    expect(container.textContent).toContain('Keeps todos, memory and subagents');
  });

  it('adds the no-summary line only while the fresh row is selected', async () => {
    const { container } = await renderDialog();
    expect(container.querySelector('[data-model-switch-fresh-extra]')).toBeNull();
    await act(async () => { modeRow(container, 'fresh').click(); });
    expect(container.textContent).toContain('Reads the saved task state directly — no call to example/old.');
  });

  it('confirms the picked mode and reports the remember choice', async () => {
    const { container, onConfirm } = await renderDialog();
    await act(async () => { modeRow(container, 'compact').click(); });
    const remember = container.querySelector<HTMLInputElement>('[data-model-switch-remember]')!;
    await act(async () => { remember.click(); });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'compact', remember: true });
  });

  it('keeps the rule scope visible under the remember checkbox', async () => {
    const { container } = await renderDialog({ matchedRuleId: 'work-rule' });
    await act(async () => { container.querySelector<HTMLInputElement>('[data-model-switch-remember]')!.click(); });
    expect(container.textContent).toContain('Applies to rule “work-rule”');
  });

  it('cancels without confirming when Esc is pressed', async () => {
    const { container, onCancel, onConfirm } = await renderDialog();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    // The pick state is untouched: no server call, so the model select keeps
    // rendering the bound model.
    expect(container.ownerDocument.body.querySelector('[data-model-switch-mode]')).not.toBeNull();
  });

  it('drops the direct row for a same-model switch and renames the panel', async () => {
    const { container, onConfirm } = await renderDialog({ fromModel: 'example/only', toModel: 'example/only' });
    expect(container.textContent).toContain('Continue with a new context');
    expect(container.querySelector('[data-model-switch-mode="direct"]')).toBeNull();
    expect(container.querySelector('[data-model-switch-mode="compact"]')).not.toBeNull();
    expect(container.querySelector('[data-model-switch-mode="fresh"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'compact', remember: false });
  });

  it('reads as queued while the agent is busy, and as an edit when changing a pending switch', async () => {
    const busy = await renderDialog({ busy: true });
    expect(busy.container.textContent).toContain('Switch when idle');
    const editing = await renderDialog({ editing: true });
    expect(editing.container.textContent).toContain('Save changes');
  });

  it('offers the settings shortcut', async () => {
    const onOpenSettings = vi.fn();
    const { container } = await renderDialog({ onOpenSettings });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-model-switch-open-settings]')!.click();
    });
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
