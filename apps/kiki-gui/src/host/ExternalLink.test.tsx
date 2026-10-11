// @vitest-environment jsdom

/**
 * ExternalLink — the one anchor for a URL that leaves the app.
 *
 * The defect it exists to fix: the desktop webview is not a browser, so a plain
 * `target="_blank"` opened nothing at all, silently. Every settings link and
 * sign-in button built that way read as a dead button. These tests hold the
 * rule that makes one component the fix for all of them, and hold the browser
 * behaviour it must not break.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { ExternalLink } from './ExternalLink';

const openUrl = vi.fn(async () => undefined);

/** Which host `useHost` reports for the next render. */
let desktop = false;

vi.mock('./index', () => ({
  useHost: () => (desktop ? { kind: 'tauri', openUrl } : { kind: 'browser' }),
}));

const roots: Root[] = [];
const containers: HTMLElement[] = [];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  openUrl.mockReset();
  openUrl.mockImplementation(async () => undefined);
  desktop = false;
});

async function render(node: React.ReactNode, host: 'browser' | 'desktop' = 'browser'): Promise<HTMLElement> {
  desktop = host === 'desktop';
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<I18nProvider>{node}</I18nProvider>); });
  return container;
}

function link(container: HTMLElement): HTMLAnchorElement {
  return container.querySelector('a')!;
}

describe('ExternalLink', () => {
  it('keeps the real href, a new tab and a closed opener', async () => {
    const container = await render(<ExternalLink href="https://example.test/docs">Docs</ExternalLink>);
    const anchor = link(container);
    expect(anchor.getAttribute('href')).toBe('https://example.test/docs');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
  });

  it('routes the click through the shell bridge on a desktop host', async () => {
    const container = await render(<ExternalLink href="https://example.test/docs">Docs</ExternalLink>, 'desktop');
    await act(async () => { link(container).click(); });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/docs');
  });

  it('leaves the click to the browser on a browser host', async () => {
    const container = await render(<ExternalLink href="https://example.test/docs">Docs</ExternalLink>);
    // jsdom does not implement navigation, so the assertion is the one that
    // matters: the shell bridge was never asked, because a browser opens it.
    await act(async () => { link(container).click(); });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('does not intercept a modified click, so open-in-new-tab still works', async () => {
    const container = await render(<ExternalLink href="https://example.test/docs">Docs</ExternalLink>, 'desktop');
    await act(async () => {
      link(container).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('reports a refused open instead of swallowing it', async () => {
    openUrl.mockRejectedValueOnce(new Error('shell refused'));
    const onOpenFailed = vi.fn();
    const container = await render(
      <ExternalLink href="https://example.test/docs" onOpenFailed={onOpenFailed}>Docs</ExternalLink>,
      'desktop',
    );
    await act(async () => { link(container).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(onOpenFailed).toHaveBeenCalledOnce();
  });

  it('still runs the caller’s own click handler', async () => {
    const onClick = vi.fn();
    const container = await render(
      <ExternalLink href="https://example.test/docs" onClick={onClick}>Docs</ExternalLink>,
      'desktop',
    );
    await act(async () => { link(container).click(); });
    expect(onClick).toHaveBeenCalledOnce();
  });
});