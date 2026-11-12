// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApprovalBlock } from '@kiki/session-core/session';
import { shortcutPreferencesSchema } from '@kiki/session-core/settings/shortcuts';
import { I18nProvider } from '../i18n';
import { applyShortcutPreferences, resetShortcutRuntime } from '../lib/shortcuts';
import { NeedsYouTray } from './NeedsYouTray';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.innerHTML = '';
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function approval(id: string, command: string): ApprovalBlock {
  return {
    kind: 'approval',
    id,
    request: {
      approval_id: id,
      session_id: 'session_test',
      tool_call_id: `call-${id}`,
      tool_name: 'Bash',
      action: `Run: ${command}`,
      tool_input_display: { kind: 'command', command },
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
}

describe('NeedsYouTray card placement', () => {
  it('steps through the items with a truthful position', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter>
            <NeedsYouTray
              placement="card"
              items={[approval('a1', 'pnpm test'), approval('a2', 'pnpm lint'), approval('a3', 'pnpm build')]}
              agentNames={new Map()}
              onResolveApproval={async () => {}}
              onAnswerQuestion={async () => {}}
              onDismissQuestion={async () => {}}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    const stepper = () => container.querySelector('[data-tray-stepper]')!;
    const current = () => container.querySelector('[data-tray-current]')!.getAttribute('data-tray-current');
    const [previous, next] = [...stepper().querySelectorAll('button')];
    expect(stepper().textContent).toContain('1 / 3');
    expect(current()).toBe('a1');

    await act(async () => { next!.click(); });
    expect(stepper().textContent).toContain('2 / 3');
    expect(current()).toBe('a2');

    await act(async () => { next!.click(); });
    expect(stepper().textContent).toContain('3 / 3');

    await act(async () => { next!.click(); });
    expect(stepper().textContent).toContain('1 / 3');

    await act(async () => { previous!.click(); });
    expect(stepper().textContent).toContain('3 / 3');
    expect(current()).toBe('a3');
  });

  it('pins the approval decision bar to the bottom of the tray scroll area and shows its top hairline only while scrolled under', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter>
            <NeedsYouTray
              placement="card"
              items={[approval('a1', Array.from({ length: 40 }, (_, i) => `echo line ${i + 1}`).join('\n'))]}
              agentNames={new Map()}
              onResolveApproval={async () => {}}
              onAnswerQuestion={async () => {}}
              onDismissQuestion={async () => {}}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    const scroller = container.querySelector<HTMLElement>('[data-tray-current]')!;
    const bar = container.querySelector<HTMLElement>('[data-approval-decision-bar]')!;
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');

    Object.defineProperty(scroller, 'scrollHeight', { value: 640, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 320, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
    expect(bar.hasAttribute('data-scrolled-under')).toBe(true);
    expect(bar.className).toContain('border-t');

    scroller.scrollTop = 320;
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
    expect(bar.hasAttribute('data-scrolled-under')).toBe(false);
  });
});

describe('NeedsYouTray approval chords', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetShortcutRuntime('windows');
  });

  async function renderTray(items: readonly ApprovalBlock[], onResolveApproval: (id: string, decision: string) => Promise<void>, root?: Root): Promise<Root> {
    let target = root;
    if (target === undefined) {
      const container = document.createElement('div');
      document.body.append(container);
      target = createRoot(container);
      roots.push(target);
    }
    const mounted = target;
    await act(async () => {
      mounted.render(
        <I18nProvider>
          <MemoryRouter>
            <NeedsYouTray
              items={items}
              agentNames={new Map()}
              onResolveApproval={onResolveApproval}
              onAnswerQuestion={async () => {}}
              onDismissQuestion={async () => {}}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    return mounted;
  }

  // Focus has fallen to <body>, as it does once a sent prompt hides the
  // composer body: the chord is "outside a text field".
  const press = (key: string) => {
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  };

  it('ignores the chords for a moment after an approval comes to the front, then decides it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetShortcutRuntime('windows');
    const onResolveApproval = vi.fn(async () => {});
    const root = await renderTray([approval('a1', 'pnpm test')], onResolveApproval);

    // A follow-up still being typed blind when the card arrives.
    press('n');
    press('y');
    expect(onResolveApproval).not.toHaveBeenCalled();

    vi.advanceTimersByTime(700);
    press('y');
    expect(onResolveApproval).toHaveBeenCalledExactlyOnceWith('a1', 'approved');

    // The next approval to come to the front is disarmed again: a double `y`
    // does not also approve it.
    await renderTray([approval('a2', 'pnpm lint')], onResolveApproval, root);
    press('y');
    expect(onResolveApproval).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(700);
    press('n');
    expect(onResolveApproval).toHaveBeenLastCalledWith('a2', 'rejected');
  });

  it('answers the remapped chords instead of a hardcoded y/n', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetShortcutRuntime('windows');
    applyShortcutPreferences(shortcutPreferencesSchema.parse({
      version: 1,
      overrides: { windows: { approve: [{ key: 'a', modifier: 'none', shift: false }], reject: [] } },
    }));
    const onResolveApproval = vi.fn(async () => {});
    await renderTray([approval('a1', 'pnpm test')], onResolveApproval);
    vi.advanceTimersByTime(700);

    press('y');
    press('n');
    expect(onResolveApproval).not.toHaveBeenCalled();
    press('a');
    expect(onResolveApproval).toHaveBeenCalledExactlyOnceWith('a1', 'approved');
  });
});
