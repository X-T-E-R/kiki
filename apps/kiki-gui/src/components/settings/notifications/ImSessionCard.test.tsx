// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ImBindingPatch, ImCatalog, ImSessionSnapshot } from '@kiki/protocol';

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
  catalog: vi.fn(async (): Promise<ImCatalog> => ({ personas: [{ id: 'ada', name: 'Ada' }], sessions: [{ id: 'sess', title: 'Notes' }] })),
  setPolicy: vi.fn(async (policy: typeof empty.policy) => ({ ...empty, policy })),
  paste: vi.fn(async (): Promise<import('@kiki/protocol').ImPasteResult> => ({ provider_instance_id: 'inst', provider_kind: 'telegram', ignored_keys: ['extra'], chat_hint_ignored: true })),
  check: vi.fn(async (): Promise<import('@kiki/protocol').ImCheckResult> => ({ ok: true, account_id: '7' })),
  listen: vi.fn(async () => found),
  confirm: vi.fn(async () => bound),
  dismiss: vi.fn(),
  updateBinding: vi.fn(async (_id: string, _patch: ImBindingPatch): Promise<ImSessionSnapshot> => bound),
  removeBinding: vi.fn(async () => empty),
  startWechatQr: vi.fn(async () => ({ login_id: 'login1', image: 'https://cdn.example/qr.png' })),
  pollWechatQr: vi.fn(async (): Promise<{ status: string; provider_instance_id?: string }> => ({ status: 'wait' })),
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

  it.each(['poll', 'verification'] as const)('starts only the account identified by the confirmed WeChat %s result', async (route) => {
    const accounts: ImSessionSnapshot = {
      ...empty,
      instances: ['wx-old', 'wx-new'].map((id) => ({ id, provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: id, adapter: 'stopped' })),
    };
    imSessions.snapshot.mockResolvedValue(accounts);
    imSessions.check.mockResolvedValue({ ok: true });
    imSessions.check.mockClear();
    imSessions.listen.mockClear();
    imSessions.listen.mockResolvedValue(accounts);
    const confirmed = { status: 'confirmed', provider_instance_id: 'wx-new' };
    imSessions.pollWechatQr.mockResolvedValueOnce(route === 'poll' ? confirmed : { status: 'need_verifycode' });
    const container = await render('1100px');
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    if (route === 'verification') {
      const field = container.querySelector<HTMLInputElement>('[data-im-wechat-verify]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '1234');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      imSessions.pollWechatQr.mockResolvedValueOnce(confirmed);
      await click(container, '[data-im-wechat-verify-submit]');
    }
    expect(imSessions.check.mock.calls).toEqual([['wx-new']]);
    expect(imSessions.listen.mock.calls).toEqual([['wx-new', true]]);
  });

  it('does not guess a WeChat account when confirmation has no instance id', async () => {
    const accounts: ImSessionSnapshot = {
      ...empty,
      instances: [{ id: 'wx-old', provider_kind: 'wechat_bridge', listening: false, configured: true, adapter: 'stopped' }],
    };
    imSessions.snapshot.mockResolvedValue(accounts);
    imSessions.check.mockClear();
    imSessions.listen.mockClear();
    imSessions.pollWechatQr.mockResolvedValueOnce({ status: 'confirmed' });
    const container = await render('1100px');
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(imSessions.check).not.toHaveBeenCalled();
    expect(imSessions.listen).not.toHaveBeenCalled();
  });

  it('shows a confirmed WeChat account check failure instead of starting another account', async () => {
    const accounts: ImSessionSnapshot = {
      ...empty,
      instances: ['wx-old', 'wx-new'].map((id) => ({ id, provider_kind: 'wechat_bridge', listening: false, configured: true, adapter: 'stopped' })),
    };
    imSessions.snapshot.mockResolvedValue(accounts);
    imSessions.check.mockResolvedValueOnce({ ok: false, detail: 'New account is unavailable' });
    imSessions.check.mockClear();
    imSessions.listen.mockClear();
    imSessions.pollWechatQr.mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'wx-new' });
    const container = await render('1100px');
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(imSessions.check.mock.calls).toEqual([['wx-new']]);
    expect(imSessions.listen).not.toHaveBeenCalled();
    expect(container.textContent).toContain('New account is unavailable');
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

  it('offers an explicit bind flow for a configured WeChat account with no discoveries yet, switches between persona and thread, starts listening, and binds', async () => {
    const wechatStopped: ImSessionSnapshot = {
      ...empty,
      instances: [{ id: 'wx-1', provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: 'wxid_user1', adapter: 'stopped' }],
    };
    const wechatListening: ImSessionSnapshot = {
      ...empty,
      instances: [{ id: 'wx-1', provider_kind: 'wechat_bridge', listening: true, configured: true, account_id: 'wxid_user1', adapter: 'running' }],
    };
    const wechatDiscovered: ImSessionSnapshot = {
      ...wechatListening,
      discoveries: [{
        id: 'd-wx',
        provider_instance_id: 'wx-1',
        provider_kind: 'wechat_bridge',
        account_id: 'wxid_user1',
        identity: { chat_id: 'wx_chat', sender_id: 'wx_sender', topic_id: '0', sender_name: 'Lin' },
        preview: 'Hi Kiki',
        at: '2026-10-22T00:00:00.000Z',
      }],
    };
    const wechatBound: ImSessionSnapshot = {
      ...wechatListening,
      discoveries: [],
      bindings: [{
        id: 'b-wx',
        provider_instance_id: 'wx-1',
        provider_kind: 'wechat_bridge',
        account_id: 'wxid_user1',
        identity: wechatDiscovered.discoveries[0]!.identity,
        session_id: 'sess',
        enabled: true,
        busy: 'queue',
        reply: 'final',
        mobile_interactions: true,
      }],
    };

    imSessions.snapshot.mockResolvedValue(wechatStopped);
    imSessions.check.mockResolvedValue({ ok: true, account_id: 'wxid_user1' });
    imSessions.listen.mockResolvedValueOnce(wechatListening);
    imSessions.confirm.mockResolvedValueOnce(wechatBound);

    const container = await render('1100px');
    expect(container.querySelector('[data-im-connect-drawer]')?.classList.contains('hidden')).toBe(true);
    expect(container.querySelector('[data-im-bind-flow]')).not.toBeNull();
    expect(container.querySelector('[data-im-instance-row="wx-1"]')?.textContent).toContain('WeChat');

    await click(container, '[data-im-target-kind="session"]');
    expect(container.querySelector('[data-im-target="session:sess"]')).not.toBeNull();

    await click(container, '[data-im-bind-listen]');
    expect(imSessions.check).toHaveBeenCalledWith('wx-1');
    expect(imSessions.listen).toHaveBeenCalledWith('wx-1', true);
    expect(container.querySelector('[data-im-waiting-discovery]')).not.toBeNull();

    imSessions.snapshot.mockResolvedValue(wechatDiscovered);
    await click(container, '[data-im-refresh-discovery]');
    expect(container.querySelector('[data-im-discovery="d-wx"]')?.textContent).toContain('Lin');

    await click(container, '[data-im-confirm="d-wx"]');
    expect(imSessions.confirm).toHaveBeenCalledWith('d-wx', expect.objectContaining({
      target: { kind: 'session', session_id: 'sess' },
      reply: 'final',
    }));
    expect(container.querySelector('[data-im-binding="b-wx"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/reply|Receive/i);
  });

  it('switches an existing binding target between a thread and a persona', async () => {
    imSessions.catalog.mockResolvedValueOnce({
      personas: [
        { id: 'ada', name: 'Ada', home_session_id: 'home' },
        { id: 'bob', name: 'Bob', home_session_id: 'bob-home' },
      ],
      sessions: [{ id: 'sess', title: 'Notes' }],
    });
    imSessions.snapshot.mockResolvedValue(bound);
    imSessions.updateBinding.mockImplementation(async (_id: string, patch: ImBindingPatch) => {
      const nextTarget = patch.target;
      const nextSessionId = nextTarget?.kind === 'persona'
        ? (nextTarget.persona_id === 'bob' ? 'bob-home' : 'home')
        : nextTarget?.kind === 'session'
          ? nextTarget.session_id
          : (patch.session_id ?? bound.bindings[0]!.session_id);
      const nextPersonaId = nextTarget?.kind === 'persona' ? nextTarget.persona_id : undefined;
      return {
        ...bound,
        bindings: [{
          ...bound.bindings[0]!,
          session_id: nextSessionId,
          persona_id: nextPersonaId,
        }],
      };
    });

    const container = await render('1100px');
    await click(container, '#im-binding-target-b1');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value="sess"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { target: { kind: 'session', session_id: 'sess' } });
    expect(container.querySelector('[data-im-binding-target="sess"]')).not.toBeNull();

    await click(container, '#im-binding-target-b1');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value="persona:bob"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { target: { kind: 'persona', persona_id: 'bob' } });
    expect(container.querySelector('[data-im-binding-target="bob-home"]')).not.toBeNull();
  });

  it('updates an existing binding row in place when re-confirming the same chat identity', async () => {
    const pausedExistingWithDiscovery: ImSessionSnapshot = {
      ...found,
      bindings: [{
        ...bound.bindings[0]!,
        id: 'b1',
        session_id: 'home',
        persona_id: 'ada',
        enabled: false,
      }],
    };
    const reconfirmedInPlace: ImSessionSnapshot = {
      ...found,
      discoveries: [],
      bindings: [{
        ...bound.bindings[0]!,
        id: 'b1',
        session_id: 'sess',
        persona_id: undefined,
        enabled: true,
      }],
    };
    imSessions.snapshot.mockResolvedValue(pausedExistingWithDiscovery);
    imSessions.confirm.mockResolvedValueOnce(reconfirmedInPlace);

    const container = await render('1100px');
    expect(container.querySelectorAll('[data-im-binding]').length).toBe(1);
    expect(container.querySelector('[data-im-enabled="b1"]')?.textContent).toBe('Enable');

    await click(container, '[data-im-target-kind="session"]');
    await click(container, '[data-im-confirm="d1"]');

    expect(imSessions.confirm).toHaveBeenCalledWith('d1', expect.objectContaining({
      target: { kind: 'session', session_id: 'sess' },
    }));
    expect(container.querySelectorAll('[data-im-binding]').length).toBe(1);
    expect(container.querySelector('[data-im-binding-target="sess"]')).not.toBeNull();
    expect(container.querySelector('[data-im-enabled="b1"]')?.textContent).toBe('Disable');
  });

  it('pastes a third account without overwriting either of two existing accounts, and only updates an account when explicitly selected', async () => {
    const twoAccounts: ImSessionSnapshot = {
      ...empty,
      instances: [
        { id: 'inst-1', provider_kind: 'wechat_bridge', listening: true, configured: true, account_id: 'wxid_1', adapter: 'running' },
        { id: 'inst-2', provider_kind: 'telegram', listening: true, configured: true, account_id: '7', adapter: 'running' },
      ],
    };
    imSessions.snapshot.mockResolvedValue(twoAccounts);
    imSessions.listen.mockResolvedValueOnce(twoAccounts).mockResolvedValueOnce(twoAccounts);
    imSessions.paste.mockClear();
    imSessions.paste.mockResolvedValueOnce({
      provider_instance_id: 'inst-3',
      provider_kind: 'feishu_app',
      ignored_keys: [],
      chat_hint_ignored: false,
    });
    imSessions.check.mockResolvedValue({ ok: true, account_id: 'cli_3' });

    const container = await render('1100px');
    await click(container, '[data-im-connect-toggle]');
    expect(container.querySelector('[data-im-instance=""]')).not.toBeNull();

    const paste = container.querySelector<HTMLTextAreaElement>('[data-im-paste]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(paste, 'app_id=cli_3\napp_secret=sec');
      paste.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container, '[data-im-check]');
    expect(imSessions.paste).toHaveBeenCalledWith('app_id=cli_3\napp_secret=sec', undefined);

    await click(container, '[data-im-connect-toggle]');
    await click(container, '#im-instance');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value="inst-2"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.querySelector('[data-im-instance="inst-2"]')).not.toBeNull();

    await click(container, '#im-instance');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value=""]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.querySelector('[data-im-instance=""]')).not.toBeNull();

    imSessions.paste.mockClear();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(paste, '999:new_bot_token');
      paste.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container, '[data-im-check]');
    expect(imSessions.paste).toHaveBeenCalledWith('999:new_bot_token', undefined);
  });

  it('scopes routeExisting to the clicked account and requires explicit chat selection when multiple bindings exist', async () => {
    const multiAccountAndBindings: ImSessionSnapshot = {
      ...empty,
      instances: [
        { id: 'wx-1', provider_kind: 'wechat_bridge', listening: true, configured: true, account_id: 'wxid_1', adapter: 'running' },
        { id: 'tg-1', provider_kind: 'telegram', listening: true, configured: true, account_id: '7', adapter: 'running' },
      ],
      bindings: [
        {
          id: 'b-wx-1',
          provider_instance_id: 'wx-1',
          provider_kind: 'wechat_bridge',
          account_id: 'wxid_1',
          identity: { chat_id: 'c-wx-1', sender_id: 'u-wx-1', topic_id: '0', sender_name: 'Lin' },
          session_id: 'home',
          persona_id: 'ada',
          enabled: true,
          busy: 'queue',
          reply: 'final',
          mobile_interactions: true,
        },
        {
          id: 'b-wx-2',
          provider_instance_id: 'wx-1',
          provider_kind: 'wechat_bridge',
          account_id: 'wxid_1',
          identity: { chat_id: 'c-wx-2', sender_id: 'u-wx-2', topic_id: '0', chat_title: 'Ops Group', sender_name: 'Chen' },
          session_id: 'home',
          persona_id: 'ada',
          enabled: true,
          busy: 'queue',
          reply: 'final',
          mobile_interactions: true,
        },
        {
          id: 'b-tg-1',
          provider_instance_id: 'tg-1',
          provider_kind: 'telegram',
          account_id: '7',
          identity: { chat_id: 'c-tg-1', sender_id: 'u-tg-1', topic_id: '0', sender_name: 'Ada' },
          session_id: 'home',
          persona_id: 'ada',
          enabled: true,
          busy: 'queue',
          reply: 'final',
          mobile_interactions: true,
        },
      ],
    };
    imSessions.snapshot.mockResolvedValue(multiAccountAndBindings);
    imSessions.updateBinding.mockClear();
    imSessions.updateBinding.mockResolvedValue(multiAccountAndBindings);

    const container = await render('1100px');

    await click(container, '[data-im-start-bind="tg-1"]');
    await click(container, '[data-im-target-kind="session"]');
    const tgRouteBtn = container.querySelector<HTMLButtonElement>('[data-im-route-existing="b-tg-1"]')!;
    expect(tgRouteBtn).not.toBeNull();
    expect(tgRouteBtn.disabled).toBe(false);
    expect(tgRouteBtn.textContent).toContain('Telegram · Ada');
    await click(container, '[data-im-route-existing="b-tg-1"]');
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b-tg-1', {
      target: { kind: 'session', session_id: 'sess' },
    });

    imSessions.updateBinding.mockClear();
    await click(container, '[data-im-start-bind="wx-1"]');
    const ambiguousRouteBtn = container.querySelector<HTMLButtonElement>('[data-im-route-existing]')!;
    expect(ambiguousRouteBtn.disabled).toBe(true);
    expect(container.querySelector('[data-im-route-binding]')).not.toBeNull();

    await click(container, '#im-route-binding');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value="b-wx-2"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const chosenWxBtn = container.querySelector<HTMLButtonElement>('[data-im-route-existing="b-wx-2"]')!;
    expect(chosenWxBtn.disabled).toBe(false);
    await click(container, '[data-im-route-existing="b-wx-2"]');
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b-wx-2', {
      target: { kind: 'session', session_id: 'sess' },
    });
  });

  it('shows Starting and Reconnecting states instead of Listening while keeping target switching and stop controls active without re-scanning', async () => {
    const offlineRecovering: ImSessionSnapshot = {
      ...bound,
      instances: [
        {
          id: 'wx-1',
          provider_kind: 'wechat_bridge',
          listening: true,
          configured: true,
          account_id: 'wxid_1',
          adapter: 'stopped',
          connection: 'reconnecting',
        },
        {
          id: 'tg-1',
          provider_kind: 'telegram',
          listening: true,
          configured: true,
          account_id: '7',
          adapter: 'running',
          connection: 'starting',
        },
      ],
      bindings: [{
        ...bound.bindings[0]!,
        id: 'b1',
        provider_instance_id: 'wx-1',
        provider_kind: 'wechat_bridge',
      }],
    };
    imSessions.snapshot.mockResolvedValue(offlineRecovering);
    imSessions.updateBinding.mockClear();
    imSessions.listen.mockClear();

    const container = await render('1100px');
    expect(container.querySelector('[data-im-connect-drawer]')?.classList.contains('hidden')).toBe(true);
    const wxState = container.querySelector('[data-im-instance-row="wx-1"] [data-im-instance-state]')!;
    expect(wxState.getAttribute('data-im-instance-state')).toBe('reconnecting');
    expect(wxState.textContent).toBe('Reconnecting');
    expect(wxState.textContent).not.toBe('Listening');

    const tgState = container.querySelector('[data-im-instance-row="tg-1"] [data-im-instance-state]')!;
    expect(tgState.getAttribute('data-im-instance-state')).toBe('starting');
    expect(tgState.textContent).toBe('Connecting');

    await click(container, '#im-binding-target-b1');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-option-value="sess"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', {
      target: { kind: 'session', session_id: 'sess' },
    });

    await click(container, '[data-im-listen="wx-1"]');
    expect(imSessions.listen).toHaveBeenCalledWith('wx-1', false);
  });
});
