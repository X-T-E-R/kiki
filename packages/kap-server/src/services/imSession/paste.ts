import type { ImProviderKind } from '@kiki/protocol';

const TELEGRAM_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u;

export interface ImPaste {
  readonly providerKind?: ImProviderKind;
  readonly credential?: string;
  readonly busy?: 'queue' | 'steer';
  readonly reply?: 'final' | 'edit';
  readonly persona?: string;
  readonly ignoredKeys: readonly string[];
  readonly chatHintIgnored: boolean;
}

export function parseImPaste(text: string): ImPaste {
  const ignored = new Set<string>();
  let providerKind: ImProviderKind | undefined;
  let credential: string | undefined;
  let busy: 'queue' | 'steer' | undefined;
  let reply: 'final' | 'edit' | undefined;
  let persona: string | undefined;
  let chatHintIgnored = false;
  let appId: string | undefined;
  let appSecret: string | undefined;
  let endpoint: string | undefined;
  let endpointKind: 'onebot_v11' | 'wechat_bridge' | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (TELEGRAM_TOKEN.test(line)) {
      providerKind = 'telegram';
      credential = line;
      continue;
    }
    const split = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/u.exec(line);
    if (split === null) {
      ignored.add(line.slice(0, 40));
      continue;
    }
    const key = split[1]!.toLowerCase();
    const value = split[2]!.trim();
    if (key === 'token' || key === 'bot_token' || key === 'telegram_token') {
      providerKind = 'telegram';
      credential = value;
    } else if (key === 'app_id' || key === 'feishu_app_id') {
      providerKind = 'feishu_app';
      appId = value;
    } else if (key === 'app_secret' || key === 'feishu_app_secret') {
      providerKind = 'feishu_app';
      appSecret = value;
    } else if (key === 'onebot' || key === 'onebot_endpoint' || key === 'qq') {
      providerKind = 'onebot_v11';
      endpointKind = 'onebot_v11';
      endpoint = value;
    } else if (key === 'wechat' || key === 'wechat_endpoint') {
      providerKind = 'wechat_bridge';
      endpointKind = 'wechat_bridge';
      endpoint = value;
    } else if (key === 'endpoint') {
      endpoint = value;
    } else if (key === 'busy' && (value === 'queue' || value === 'steer')) busy = value;
    else if (key === 'reply' && (value === 'final' || value === 'edit')) reply = value;
    else if (key === 'persona') persona = value;
    else if (key === 'chat' || key === 'chat_id' || key === 'topic' || key === 'message_thread_id') chatHintIgnored = true;
    else ignored.add(key);
  }
  if (providerKind === 'feishu_app' && appId !== undefined && appSecret !== undefined) credential = `${appId}\n${appSecret}`;
  if ((providerKind === 'onebot_v11' || providerKind === 'wechat_bridge') && endpoint !== undefined) credential = endpoint;
  if (providerKind === undefined && endpoint !== undefined && endpointKind !== undefined) {
    providerKind = endpointKind;
    credential = endpoint;
  }
  if (providerKind === 'telegram' && credential !== undefined && !TELEGRAM_TOKEN.test(credential)) {
    ignored.add('token');
    credential = undefined;
  }
  return { providerKind, credential, busy, reply, persona, ignoredKeys: [...ignored], chatHintIgnored };
}
