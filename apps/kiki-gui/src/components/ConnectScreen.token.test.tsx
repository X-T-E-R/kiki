// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { browserHost, HostProvider } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectScreen } from './ConnectScreen';

beforeAll(() => {
  vi.stubGlobal('__KIKI_PROXY_TARGET__', 'http://127.0.0.1:58627');
  vi.stubGlobal('navigator', { language: 'en-US' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('reveals and overwrites a prefilled manual connection token', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onConnect = vi.fn();
  try {
    await act(async () => {
      root.render(<HostProvider host={browserHost}><I18nProvider>
        <ConnectScreen
          initial={{ url: 'http://example.test:1234', token: 'saved-token' }}
          connecting={false}
          error={null}
          onConnect={onConnect}
          onBack={undefined}
          desktopBoot={null}
          desktopFailure={null}
          onRetryDesktop={() => {}}
          onCancelDesktopBoot={() => {}}
          onConnectSsh={async () => {}}
        />
      </I18nProvider></HostProvider>);
    });
    const token = container.querySelector<HTMLInputElement>('#connect-token')!;
    expect(token.type).toBe('password');
    expect(token.value).toBe('saved-token');
    await act(async () => {
      container.querySelector('[aria-label="Show Bearer token"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(token.type).toBe('text');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(token, 'replacement-token');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onConnect).toHaveBeenCalledWith({ url: 'http://example.test:1234', token: 'replacement-token' });
    await act(async () => {
      container.querySelector('[aria-label="Hide Bearer token"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(token.type).toBe('password');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
