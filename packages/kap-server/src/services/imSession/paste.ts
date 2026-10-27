import type { ImBusyDelivery, ImProviderKind } from '@kiki/protocol';

const TELEGRAM_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u;

export interface ImPaste {
  readonly providerKind?: ImProviderKind;
  readonly credential?: string;
  readonly busy?: ImBusyDelivery;
  readonly reply?: 'final' | 'edit';
  readonly persona?: string;
  readonly ignoredKeys: readonly string[];
  readonly chatHintIgnored: boolean;
}

export function parseImPaste(text: string): ImPaste {
  const fields = new Map(text.split(/\r?\n/u).flatMap((line) => {
    const pair = /^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.*?)\s*$/u.exec(line);
    return pair === null ? [] : [[pair[1]!.toLowerCase(), pair[2]!] as const];
  }));
  const platform = fields.get('platform') ?? fields.get('provider_kind');
  const explicit = platform === 'discord' || platform === 'slack' || platform === 'matrix' ? platform : undefined;
  const inferred = fields.has('homeserver') ? 'matrix' : fields.has('app_token') || fields.get('bot_token')?.startsWith('xoxb-') ? 'slack' : undefined;
  const provider = explicit ?? inferred;
  if (provider !== undefined) {
    const keys = provider === 'discord' ? ['bot_token'] : provider === 'slack' ? ['bot_token', 'app_token'] : ['homeserver', 'access_token'];
    const values = keys.map((key) => fields.get(key)?.trim());
    const complete = values.every((value) => value !== undefined && value.length > 0);
    const known = new Set(['platform', 'provider_kind', ...keys]);
    return { providerKind: provider, credential: complete ? values.join('\n') : undefined, ignoredKeys: [...fields.keys()].filter((key) => !known.has(key)), chatHintIgnored: fields.has('chat_id') || fields.has('topic_id') };
  }
  const ignored = new Set<string>();
  let providerKind: ImProviderKind | undefined;
  let credential: string | undefined;
  let busy: ImBusyDelivery | undefined;
  let reply: 'final' | 'edit' | undefined;
  let persona: string | undefined;
  let chatHintIgnored = false;
  let appId: string | undefined;
  let appSecret: string | undefined;
  let endpoint: string | undefined;
  let endpointKind: 'onebot_v11' | 'wechat_bridge' | undefined;
  let oneBotMode: 'forward' | 'reverse' | undefined;
  let accessToken: string | undefined;
  let listenPort: number | undefined;
  let wechatToken: string | undefined;
  let wechatAccount: string | undefined;
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
    } else if (key === 'mode' && (value === 'forward' || value === 'reverse')) oneBotMode = value;
    else if (key === 'access_token') accessToken = value;
    else if (key === 'listen_port' && /^[0-9]{1,5}$/u.test(value)) listenPort = Number(value);
    else if (key === 'wechat_token' || key === 'ilink_token') {
      providerKind = 'wechat_bridge';
      wechatToken = value;
    } else if (key === 'wechat_account') wechatAccount = value;
    else if (key === 'wechat' || key === 'wechat_endpoint') {
      if (/^(https?|wss?):\/\//u.test(value)) ignored.add(key);
      else {
        providerKind = 'wechat_bridge';
        wechatToken = value;
      }
    } else if (key === 'endpoint') {
      endpoint = value;
    } else if (key === 'busy' && (value === 'immediate' || value === 'queue' || value === 'steer')) busy = value;
    else if (key === 'reply' && (value === 'final' || value === 'edit')) reply = value;
    else if (key === 'persona') persona = value;
    else if (key === 'chat' || key === 'chat_id' || key === 'topic' || key === 'message_thread_id') chatHintIgnored = true;
    else ignored.add(key);
  }
  if (providerKind === 'feishu_app' && appId !== undefined && appSecret !== undefined) credential = `${appId}\n${appSecret}`;
  if (providerKind === 'onebot_v11' && endpoint !== undefined) {
    credential = JSON.stringify({
      mode: oneBotMode ?? 'forward', endpoint,
      ...(accessToken === undefined ? {} : { access_token: accessToken }),
      ...(listenPort === undefined ? {} : { listen_port: listenPort }),
    });
  }
  if (providerKind === 'wechat_bridge' && wechatToken !== undefined) credential = wechatAccount === undefined ? wechatToken : `${wechatToken}\n${wechatAccount}`;
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
