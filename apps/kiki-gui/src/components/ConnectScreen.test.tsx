import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { normalizeDesktopFailure } from '../state/connection';
import type { DesktopBootStatus } from '../state/connection';
import { ConnectScreen } from './ConnectScreen';

// Copy assertions are English: pin the locale source (Node's built-in
// navigator reports the OS language) for the whole file. The browser form
// also reads the Vite-injected proxy target constant.
beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('__KIKI_PROXY_TARGET__', 'http://127.0.0.1:58627');
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const baseProps = {
  initial: { url: 'http://example.test:1234', token: 'secret-token' },
  connecting: false,
  error: null,
  onConnect: () => {},
  onBack: undefined,
  onRetryDesktop: () => {},
  onCancelDesktopBoot: () => {},
};

function renderScreen(props: Partial<Parameters<typeof ConnectScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConnectScreen {...baseProps} {...(props as Parameters<typeof ConnectScreen>[0])} />
    </I18nProvider>,
  );
}

describe('ConnectScreen desktop boot card', () => {
  it('renders the spawning phase with cancel instead of the URL/token form', () => {
    const boot: DesktopBootStatus = { stage: 'spawning', startedAtMs: Date.now() };
    const html = renderScreen({ desktopBoot: boot, desktopFailure: null });
    expect(html).toContain('Starting the Kiki desktop backend');
    expect(html).toContain('Cancel startup');
    expect(html).not.toContain('connect-server-url');
    expect(html).not.toContain('connect-token');
  });

  it('renders the waiting phase copy once the sidecar exists', () => {
    const boot: DesktopBootStatus = { stage: 'waiting', startedAtMs: Date.now() };
    const html = renderScreen({ desktopBoot: boot, desktopFailure: null });
    expect(html).toContain('Backend started');
    expect(html).toContain('waiting for it to become ready');
    expect(html).toContain('elapsed');
  });
});

describe('ConnectScreen desktop failure card', () => {
  it('shows message, log path, retry and diagnostics instead of the form', () => {
    const html = renderScreen({
      desktopBoot: null,
      desktopFailure: {
        message: 'Kiki backend (pid 4242) exited during startup (exit code 1)\nstderr (last 2 lines):\nboom\nbang',
        stderrTail: ['boom', 'bang'],
        logPath: 'C:/Users/example/.kimi-code/desktop-backend.log',
      },
    });
    expect(html).toContain('Kiki desktop backend failed to start');
    expect(html).toContain('exit code 1');
    expect(html).toContain('desktop-backend.log');
    expect(html).toContain('Retry startup');
    expect(html).toContain('Copy diagnostics');
    expect(html).not.toContain('connect-server-url');
    expect(html).not.toContain('secret-token');
  });
});

describe('ConnectScreen browser form', () => {
  it('still renders manual entry when neither desktop card applies', () => {
    const html = renderScreen({ desktopBoot: null, desktopFailure: null, error: 'handoff failed' });
    expect(html).toContain('connect-server-url');
    expect(html).toContain('connect-token');
    expect(html).toContain('handoff failed');
  });
});

describe('normalizeDesktopFailure', () => {
  it('keeps the structured shell rejection intact', () => {
    expect(
      normalizeDesktopFailure({
        message: 'exited during startup (exit code 1)',
        stderrTail: ['a', 'b'],
        logPath: 'C:/logs/desktop-backend.log',
      }),
    ).toEqual({
      message: 'exited during startup (exit code 1)',
      stderrTail: ['a', 'b'],
      logPath: 'C:/logs/desktop-backend.log',
    });
  });

  it('tolerates a structured rejection with missing optional fields', () => {
    expect(normalizeDesktopFailure({ message: 'plain message' })).toEqual({
      message: 'plain message',
      stderrTail: [],
      logPath: null,
    });
  });

  it('filters non-string tail entries and falls back for non-object errors', () => {
    const noisy = normalizeDesktopFailure({
      message: 'm',
      stderrTail: ['ok', 7],
      logPath: 42,
    });
    expect(noisy.stderrTail).toEqual(['ok']);
    expect(noisy.logPath).toBeNull();

    expect(normalizeDesktopFailure(new Error('boom'))).toEqual({
      message: 'boom',
      stderrTail: [],
      logPath: null,
    });
    expect(normalizeDesktopFailure('raw failure').message).toBe('raw failure');
    expect(normalizeDesktopFailure({ weird: true }).message).toBeTypeOf('string');
  });
});
