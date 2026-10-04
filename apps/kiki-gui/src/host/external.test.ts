// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalUrl, reserveExternalBrowserTab } from './external';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function tabFixture() {
  const tab = { opener: window, closed: false, document: document.implementation.createHTMLDocument(), close: vi.fn() };
  const navigate = vi.fn<(link: HTMLAnchorElement) => void>();
  const create = tab.document.createElement.bind(tab.document);
  vi.spyOn(tab.document, 'createElement').mockImplementation((tag) => {
    const element = create(tag);
    if (element instanceof HTMLAnchorElement) element.click = () => navigate(element);
    return element;
  });
  const open = vi.fn(() => tab); vi.stubGlobal('open', open);
  return { tab, open, navigate };
}

describe('external URL opening', () => {
  it('keeps the native host path and its failures unchanged', async () => {
    const openUrl = vi.fn(async () => {}); const open = vi.fn(); vi.stubGlobal('open', open);
    await openExternalUrl({ openUrl }, 'https://example.test/docs', 'blocked');
    expect(openUrl).toHaveBeenCalledWith('https://example.test/docs'); expect(open).not.toHaveBeenCalled();
    openUrl.mockRejectedValue(new Error('native failure'));
    await expect(openExternalUrl({ openUrl }, 'https://example.test/docs', 'blocked')).rejects.toThrow('native failure');
  });

  it('opens a blank tab, isolates opener and referrer before navigation, without noopener null false positives', async () => {
    const { tab, open, navigate } = tabFixture();
    navigate.mockImplementation((link) => {
      expect(tab.opener).toBeNull(); expect(link.href).toBe('https://example.test/docs');
      expect(link.rel).toBe('noreferrer'); expect(link.referrerPolicy).toBe('no-referrer'); expect(link.target).toBe('_self');
    });
    await openExternalUrl({}, 'https://example.test/docs', 'blocked');
    expect(open).toHaveBeenCalledWith('about:blank', '_blank'); expect(navigate).toHaveBeenCalledOnce(); expect(tab.close).not.toHaveBeenCalled();
  });

  it('reserves a user-gesture tab without navigating until the authorization URL arrives', () => {
    const { tab, navigate } = tabFixture(); const reserved = reserveExternalBrowserTab('blocked');
    expect(navigate).not.toHaveBeenCalled();
    reserved.navigate('https://example.test/verify'); expect(navigate.mock.calls[0]![0].href).toBe('https://example.test/verify');
    reserved.close(); expect(tab.close).toHaveBeenCalledOnce();
  });

  it('reports true blocked, unavailable or closed windows, and cleans up navigation failures', async () => {
    vi.stubGlobal('open', () => null);
    await expect(openExternalUrl({}, 'https://example.test/docs', 'blocked')).rejects.toThrow('blocked');
    vi.stubGlobal('open', undefined);
    await expect(openExternalUrl({}, 'https://example.test/docs', 'blocked')).rejects.toThrow('blocked');
    const { tab, navigate } = tabFixture(); tab.closed = true;
    await expect(openExternalUrl({}, 'https://example.test/docs', 'blocked')).rejects.toThrow('blocked'); expect(tab.close).toHaveBeenCalledOnce();
    tab.closed = false; tab.close.mockClear(); navigate.mockImplementation(() => { throw new Error('navigation failed'); });
    await expect(openExternalUrl({}, 'https://example.test/docs', 'blocked')).rejects.toThrow('navigation failed'); expect(tab.close).toHaveBeenCalledOnce();
  });
});
