// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ImSessionSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { ImSessionCard } from './ImSessionCard';

const empty: ImSessionSnapshot = { policy: { allowed: true, default_enabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], voice_fallbacks: 0 };
const found: ImSessionSnapshot = {
  ...empty,
  instances: [{ id: 'inst', provider_kind: 'telegram' as const, listening: true, configured: true, account_id: '7', adapter: 'running' as const }],
  discoveries: [{ id: 'd1', provider_instance_id: 'inst', provider_kind: 'telegram' as const, account_id: '7', identity: { chat_id: 'c', sender_id: 'u', topic_id: '0', sender_name: 'Ada' }, preview: 'hello', at: '2026-10-21T00:00:00.000Z' }],
};
const bound: ImSessionSnapshot = {
  ...found,
  discoveries: [],
  bindings: [{ id: 'b1', provider_instance_id: 'inst', provider_kind: 'telegram' as const, account_id: '7', identity: found.discoveries[0]!.identity, session_id: 'home', persona_id: 'ada', enabled: true, busy: 'queue' as const, reply: 'final' as const, mobile_interactions: true }],
};

const imSessions = {
  snapshot: vi.fn(async () => empty),
  catalog: vi.fn(async () => ({ personas: [{ id: 'ada', name: 'Ada' }], sessions: [{ id: 'sess', title: 'Notes' }] })),
  setPolicy: vi.fn(async (policy: typeof empty.policy) => ({ ...empty, policy })),
  paste: vi.fn(async () => ({ provider_instance_id: 'inst', provider_kind: 'telegram' as const, ignored_keys: ['extra'], chat_hint_ignored: true })),
  check: vi.fn(async () => ({ ok: true, account_id: '7' })),
  listen: vi.fn(async () => found),
  confirm: vi.fn(async () => bound),
  dismiss: vi.fn(),
  updateBinding: vi.fn(async () => bound),
  removeBinding: vi.fn(async () => empty),
  startWechatQr: vi.fn(async () => ({ login_id: 'login1', image: 'https://cdn.example/qr.png' })),
  pollWechatQr: vi.fn(async () => ({ status: 'wait' })),
  cancelWechatQr: vi.fn(async () => ({})),
};

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({ scopeId: 'fixture', client: { imSessions } }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  imSessions.snapshot.mockResolvedValue(empty);
});

async function render(width: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  container.dataset['imFixture'] = 'client';
  container.style.width = width;
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><I18nProvider><ImSessionCard /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function click(container: HTMLDivElement, selector: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('ImSessionCard', () => {
  it('mounts the phone session controls at a narrow and a wide width', async () => {
    imSessions.snapshot.mockResolvedValue(found);
    for (const width of ['360px', '1100px']) {
      const container = await render(width);
      expect(container.style.width).toBe(width);
      expect(container.dataset['imFixture']).toBe('client');
      expect(container.querySelector('[data-im-session]')).not.toBeNull();
      expect(container.textContent).toContain('Phone session');
      expect(container.textContent).toContain('Paste a setup and check it, then bind the phone message to a session.');
      expect(container.textContent).toContain('Enable new bindings');
      expect(container.textContent).toContain('Phone actions');
      expect(container.textContent).toContain('Full text');
      expect(container.textContent).toContain('Live text');
      expect(container.textContent).not.toContain('QQ cannot take a file.');
      expect(container.textContent).not.toContain('WeChat sends the full text');
      expect(container.textContent).toContain('Queue');
      expect(container.querySelector('[data-im-actions]')).not.toBeNull();
      expect(container.textContent).not.toMatch(/reply|Receive/i);
      await act(async () => { roots[0]?.unmount(); });
      roots.splice(0);
      container.remove();
      containers.splice(0);
    }
  });

  it('checks a pasted setup, shows the discovered sender, and binds a persona', async () => {
    const container = await render('1100px');
    const paste = container.querySelector<HTMLTextAreaElement>('[data-im-paste]')!;
    const value = '123456:abcdefghijklmnopqrstuvwxyz\nchat_id=9\nextra=1';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(paste, value);
      paste.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container, '[data-im-check]');
    expect(imSessions.paste).toHaveBeenCalledWith('123456:abcdefghijklmnopqrstuvwxyz\nchat_id=9\nextra=1', undefined);
    expect(imSessions.check).toHaveBeenCalledWith('inst');
    expect(imSessions.listen).toHaveBeenCalledWith('inst', true);
    expect(container.querySelector('[data-im-discovery="d1"]')?.textContent).toContain('Ada');
    expect(container.querySelector('[data-im-chat-hint]')).not.toBeNull();
    expect(container.textContent).toContain('Full text');
    expect(container.querySelector<HTMLButtonElement>('[data-im-confirm="d1"]')!.disabled).toBe(false);
    await click(container, '[data-im-confirm="d1"]');
    expect(imSessions.confirm).toHaveBeenCalledWith('d1', expect.objectContaining({
      target: { kind: 'persona', persona_id: 'ada' }, busy: 'queue', reply: 'final', mobile_interactions: true,
    }));
    expect(container.querySelector('[data-im-binding="b1"]')).not.toBeNull();
  });

  it('shows a discovery that arrives while a connection is listening', async () => {
    const listening: ImSessionSnapshot = { ...empty, instances: [{ id: 'inst', provider_kind: 'telegram', listening: true, configured: true, adapter: 'running' }] };
    imSessions.snapshot.mockResolvedValueOnce(listening).mockResolvedValue(found);
    const container = await render('360px');
    expect(container.querySelector('[data-im-discovery="d1"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_500)); });
    expect(container.querySelector('[data-im-discovery="d1"]')?.textContent).toContain('Ada');
  }, 8_000);

  it('checks the only saved connection without pasting the token again', async () => {
    const saved: ImSessionSnapshot = { ...empty, instances: [{ id: 'inst', provider_kind: 'telegram', listening: false, configured: true, adapter: 'stopped' }] };
    imSessions.snapshot.mockResolvedValue(saved);
    imSessions.paste.mockClear();
    imSessions.check.mockClear();
    const container = await render('1100px');
    const check = container.querySelector<HTMLButtonElement>('[data-im-check]')!;
    expect(check.disabled).toBe(false);
    await click(container, '[data-im-check]');
    expect(imSessions.paste).not.toHaveBeenCalled();
    expect(imSessions.check).toHaveBeenCalledWith('inst');
  });

  it('shows the effective session switch and can change the target and phone actions', async () => {
    const quiet: ImSessionSnapshot = {
      ...bound,
      policy: { allowed: true, default_enabled: false },
      bindings: [{ ...bound.bindings[0]!, session_enabled: undefined }],
    };
    imSessions.snapshot.mockResolvedValue(quiet);
    const container = await render('1100px');
    expect(container.querySelector('[data-im-session-switch="b1"]')?.textContent).toContain('Off');
    expect(container.querySelector('[data-im-follow-default="b1"]')).toBeNull();
    await click(container, '[data-im-binding-actions="off"]');
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { mobile_interactions: false });
    expect(container.querySelector('[data-im-binding-target="home"]')).not.toBeNull();
  });

  it('draws a WeChat code from the returned link and keeps an image payload as an image', async () => {
    const container = await render('360px');
    imSessions.startWechatQr.mockResolvedValueOnce({ login_id: 'login1', image: 'https://cdn.example/qr.png' });
    await click(container, '[data-im-wechat-scan]');
    const drawn = container.querySelector('[data-im-wechat-image]')?.getAttribute('src') ?? '';
    expect(drawn.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(drawn)).toContain('<rect');
    expect(container.querySelector<HTMLInputElement>('[data-im-wechat-code]')?.value).toBe('https://cdn.example/qr.png');
    imSessions.startWechatQr.mockResolvedValueOnce({ login_id: 'login2', image: 'data:image/png;base64,aaaa' });
    await click(container, '[data-im-wechat-scan]');
    expect(container.querySelector('[data-im-wechat-image]')?.getAttribute('src')).toBe('data:image/png;base64,aaaa');
    imSessions.startWechatQr.mockResolvedValueOnce({ login_id: 'login3', image: 'qr-payload' });
    await click(container, '[data-im-wechat-scan]');
    const payload = container.querySelector('[data-im-wechat-image]')?.getAttribute('src') ?? '';
    expect(payload.startsWith('data:image/svg+xml')).toBe(true);
    expect(container.querySelector('[data-im-wechat-code]')).toBeNull();
    expect(container.textContent).not.toMatch(/reply|Receive/i);
  });

  it('shows full text for QQ and WeChat and keeps live text on Telegram', async () => {
    const qq = {
      ...found,
      discoveries: [{ ...found.discoveries[0]!, provider_kind: 'onebot_v11' as const }],
      bindings: [{ ...bound.bindings[0]!, provider_kind: 'wechat_bridge' as const, reply: 'edit' as const }],
    };
    imSessions.snapshot.mockResolvedValue(qq);
    const container = await render('1100px');
    const discovery = container.querySelector('[data-im-discovery="d1"]')!;
    expect(discovery.querySelector('[data-im-text="edit"]')).toBeNull();
    expect(discovery.textContent).toContain('QQ sends the full text and cannot change a sent message.');
    expect(discovery.textContent).toContain('QQ cannot take a file.');
    expect(discovery.textContent).not.toContain('Live text');
    const row = container.querySelector('[data-im-binding="b1"]')!;
    expect(row.querySelector('[data-im-binding-text="edit"]')).toBeNull();
    expect(row.querySelector('[data-im-text-fixed="wechat_bridge"]')?.textContent).toBe('Full text');
    expect(row.textContent).toContain('WeChat sends the full text and cannot change a sent message.');
    expect(row.textContent).not.toContain('QQ cannot take a file.');
    await click(container, '[data-im-confirm="d1"]');
    expect(imSessions.confirm).toHaveBeenCalledWith('d1', expect.objectContaining({ reply: 'final' }));
    expect(container.textContent).not.toMatch(/reply|Receive/i);
  });

  it('stops a listener without checking and does not start after a failed check', async () => {
    const listening: ImSessionSnapshot = { ...empty, instances: [{ id: 'inst', provider_kind: 'telegram', listening: true, configured: true, adapter: 'running' }] };
    const stopped: ImSessionSnapshot = { ...empty, instances: [{ id: 'inst', provider_kind: 'telegram', listening: false, configured: true, adapter: 'stopped' }] };
    imSessions.snapshot.mockResolvedValue(listening);
    imSessions.listen.mockResolvedValueOnce(stopped);
    const container = await render('1100px');
    imSessions.check.mockClear();
    await click(container, '[data-im-listen="inst"]');
    expect(imSessions.check).not.toHaveBeenCalled();
    expect(imSessions.listen).toHaveBeenCalledWith('inst', false);
    imSessions.snapshot.mockResolvedValue(stopped);
    imSessions.check.mockResolvedValue({ ok: false, detail: 'Credential expired' });
    imSessions.listen.mockClear();
    await click(container, '[data-im-listen="inst"]');
    expect(imSessions.check).toHaveBeenCalledWith('inst');
    expect(imSessions.listen).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Credential expired');
    expect(container.querySelector('[data-im-listen="inst"]')?.textContent).toContain('Listen');
  });
});
