// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApprovalBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
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
});
