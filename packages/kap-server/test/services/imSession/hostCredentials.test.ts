import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IConfigService, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { NotificationService } from '../../../src/services/notifications/notificationService';
import { createImSessionHost, mergeQuestionAnswers, readHostLocale } from '../../../src/services/imSession/host';

describe('im session credentials', () => {
  let home = '';
  let service: NotificationService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
    if (home !== '') await rm(home, { recursive: true, force: true });
    home = '';
  });

  it('stores a non-Telegram secret in the notification slot and keeps the same instance', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-im-session-'));
    let stored: unknown;
    const config = {
      ready: Promise.resolve(),
      get: () => stored,
      replaceSections: async (sections: Record<string, unknown>) => { stored = sections['notifications']; },
    };
    const core = { instantiation: { provide() {} }, accessor: { get: (key: unknown) => {
      if (key === IConfigService) return config;
      if (key === ISessionManager) return { list: () => [] };
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    service = new NotificationService(core, home, () => false, () => undefined);
    await service.start();
    const bridge = await createImSessionHost({ core, homeDir: home, notifications: service, logger: { info() {} } });
    const secret = 'cli_a\ns3cr3t-value';
    const first = await bridge.paste({ text: 'app_id=cli_a\napp_secret=s3cr3t-value' });
    const second = await bridge.paste({ text: 'app_id=cli_a\napp_secret=s3cr3t-value' });
    expect(second.provider_instance_id).toBe(first.provider_instance_id);
    expect(existsSync(join(home, 'im-session-secrets.json'))).toBe(false);
    const settings = service.getSettings();
    const instance = settings.provider_instances[first.provider_instance_id];
    const slot = instance?.options['token_slot'];
    expect(typeof slot).toBe('string');
    expect(service.revealCredential(String(slot))).toBe(secret);
    expect(JSON.stringify(settings)).not.toContain('s3cr3t-value');
    for (const [provider, values] of [
      ['discord', 'bot_token=discord-example'],
      ['slack', 'bot_token=xoxb-example\napp_token=xapp-example'],
      ['matrix', 'homeserver=https://matrix.example.test\naccess_token=matrix-example'],
    ] as const) {
      const pasted = await bridge.paste({ text: `platform=${provider}\n${values}` });
      expect(pasted.provider_kind).toBe(provider);
      const current = service.getSettings();
      const created = current.provider_instances[pasted.provider_instance_id]!;
      expect(created.provider_id).toBe(provider);
      expect(created.options['session_kind']).toBe(provider);
      expect(service.revealCredential(String(created.options['token_slot']))).toBe(values.split('\n').map((line) => line.slice(line.indexOf('=') + 1)).join('\n'));
      expect((await bridge.snapshot()).instances.find((item) => item.id === pasted.provider_instance_id)).toMatchObject({ provider_kind: provider, configured: true, listening: false });
      expect(JSON.stringify(current)).not.toContain('xoxb-example');
      expect(JSON.stringify(current)).not.toContain('matrix-example');
    }
    await bridge.close();
  });

  it('reads locale from desktop.json and merges each question before completing', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-im-locale-'));
    await writeFile(join(home, 'desktop.json'), JSON.stringify({ locale: 'zh' }), 'utf8');
    expect(readHostLocale(home)).toBe('zh');
    const questions = [{ question: 'A', options: [{ label: 'One' }] }, { question: 'B', options: [{ label: 'Two' }] }];
    const partial = mergeQuestionAnswers(questions, {}, { kind: 'single', questionKey: 'A', optionIds: ['opt_0_0'], method: 'number_key' });
    expect(partial.complete).toBe(false);
    expect(partial.answers).toEqual({ A: 'One', q_0: 'One' });
    const done = mergeQuestionAnswers(questions, partial.answers, { kind: 'single', questionKey: 'B', optionIds: ['opt_1_0'], method: 'number_key' });
    expect(done.complete).toBe(true);
    expect(done.answers).toEqual({ A: 'One', q_0: 'One', B: 'Two', q_1: 'Two' });
  });
});
