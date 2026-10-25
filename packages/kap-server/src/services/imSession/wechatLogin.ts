import { randomUUID } from 'node:crypto';

const BASE = 'https://ilinkai.weixin.qq.com';
const UIN = Buffer.from('kiki-im-wechat', 'utf8').toString('base64');
const START_HEADERS = {
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': UIN,
};
const POLL_HEADERS = {
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': '512',
};

export interface WechatLoginResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type WechatLoginFetch = (url: string, init: RequestInit) => Promise<WechatLoginResponse>;

export interface WechatQrStart {
  readonly login_id: string;
  readonly image: string;
}

export interface WechatQrPoll {
  readonly status: string;
  readonly provider_instance_id?: string;
  readonly account_id?: string;
}

interface Attempt {
  readonly id: string;
  readonly qrcode: string;
  base: string;
  controller: AbortController;
}

export function wechatEndpointAllowed(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  return host === 'ilinkai.weixin.qq.com' || host.endsWith('.weixin.qq.com');
}

export function wechatPollBase(redirectHost: string): string | undefined {
  const trimmed = redirectHost.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.includes('://') && /[\s/?#@]/u.test(trimmed)) return undefined;
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  if (!wechatEndpointAllowed(candidate)) return undefined;
  const host = new URL(candidate).hostname.toLowerCase().replace(/\.$/u, '');
  return `https://${host}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class WechatQrLogin {
  private readonly attempts = new Map<string, Attempt>();
  private readonly secrets = new Set<string>();

  constructor(
    private readonly fetchImpl: WechatLoginFetch,
    private readonly tokens: () => readonly string[],
    private readonly store: (credential: string, accountId: string) => Promise<{ instanceId: string }>,
  ) {}

  async start(): Promise<WechatQrStart> {
    const tokens = this.tokens().map((token) => token.trim()).filter((token) => token.length > 0).slice(0, 10);
    for (const token of tokens) this.secrets.add(token);
    const url = `${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
    const body = await this.request(url, { method: 'POST', headers: START_HEADERS, body: JSON.stringify({ local_token_list: tokens }) });
    const qrcode = typeof body['qrcode'] === 'string' ? body['qrcode'] : '';
    const image = typeof body['qrcode_img_content'] === 'string' ? body['qrcode_img_content'] : '';
    if (qrcode.length === 0 || image.length === 0) throw new Error('wechat_login_failed');
    this.secrets.add(qrcode);
    const id = randomUUID();
    this.attempts.set(id, { id, qrcode, base: BASE, controller: new AbortController() });
    return { login_id: id, image };
  }

  async poll(id: string, verifyCode?: string): Promise<WechatQrPoll> {
    const attempt = this.attempts.get(id);
    if (attempt === undefined) throw new Error('unknown_login');
    attempt.controller.abort();
    const controller = new AbortController();
    attempt.controller = controller;
    const url = new URL('/ilink/bot/get_qrcode_status', attempt.base);
    url.searchParams.set('qrcode', attempt.qrcode);
    if (verifyCode !== undefined && verifyCode.length > 0) url.searchParams.set('verify_code', verifyCode);
    const body = await this.request(url.toString(), { method: 'GET', headers: POLL_HEADERS, signal: controller.signal }, attempt.qrcode);
    if (controller.signal.aborted || !this.attempts.has(id)) throw new Error('wechat_login_cancelled');
    const status = typeof body['status'] === 'string' ? body['status'] : '';
    if (status === 'wait' || status === 'scaned' || status === 'need_verifycode') return { status };
    if (status === 'scaned_but_redirect') {
      const next = wechatPollBase(typeof body['redirect_host'] === 'string' ? body['redirect_host'] : '');
      if (next === undefined) {
        this.attempts.delete(id);
        throw new Error('wechat_redirect_rejected');
      }
      attempt.base = next;
      return { status };
    }
    if (status === 'expired' || status === 'verify_code_blocked' || status === 'binded_redirect') {
      this.attempts.delete(id);
      return { status };
    }
    if (status !== 'confirmed') {
      this.attempts.delete(id);
      throw new Error('wechat_login_failed');
    }
    const token = typeof body['bot_token'] === 'string' ? body['bot_token'].trim() : '';
    const accountId = typeof body['ilink_bot_id'] === 'string' ? body['ilink_bot_id'].trim() : '';
    const baseUrl = typeof body['baseurl'] === 'string' ? body['baseurl'].trim() : '';
    if (token.length > 0) this.secrets.add(token);
    this.attempts.delete(id);
    if (token.length === 0 || accountId.length === 0) throw new Error('wechat_login_failed');
    if (baseUrl.length > 0 && !wechatEndpointAllowed(baseUrl)) throw new Error('wechat_base_url_rejected');
    const credential = baseUrl.length > 0 ? `${token}\n${accountId}\n${baseUrl}` : `${token}\n${accountId}`;
    let instanceId: string;
    try {
      instanceId = (await this.store(credential, accountId)).instanceId;
    } catch (error) {
      throw new Error(this.scrub(error instanceof Error ? error.message : 'wechat_login_failed'));
    }
    return { status: 'confirmed', provider_instance_id: instanceId, account_id: accountId };
  }

  async cancel(id: string): Promise<void> {
    const attempt = this.attempts.get(id);
    if (attempt === undefined) return;
    attempt.controller.abort();
    this.attempts.delete(id);
  }

  private async request(url: string, init: RequestInit, qrcode?: string): Promise<Record<string, unknown>> {
    if (qrcode !== undefined && qrcode.length > 0) this.secrets.add(qrcode);
    let response: WechatLoginResponse;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (isAbort(error)) throw new Error('wechat_login_cancelled');
      throw new Error(this.scrub(error instanceof Error ? error.message : 'wechat_login_failed'));
    }
    if (init.signal?.aborted) throw new Error('wechat_login_cancelled');
    let text = '';
    try { text = await response.text(); } catch (error) {
      if (isAbort(error)) throw new Error('wechat_login_cancelled');
      throw new Error('wechat_login_failed');
    }
    if (response.status !== 200) throw new Error('wechat_login_failed');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('wechat_login_failed'); }
    const body = recordOf(parsed);
    if (body === undefined) throw new Error('wechat_login_failed');
    const token = typeof body['bot_token'] === 'string' ? body['bot_token'] : '';
    if (token.length > 0) this.secrets.add(token);
    return body;
  }

  private scrub(message: string): string {
    let text = message;
    for (const secret of this.secrets) {
      if (secret.length > 0) text = text.split(secret).join('[redacted]');
    }
    return text.length > 0 ? text : 'wechat_login_failed';
  }
}
