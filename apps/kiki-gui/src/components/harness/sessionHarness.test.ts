import { describe, expect, it } from 'vitest';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';

import { codexRefusesKikiTools, harnessDenies, sessionHarnessOf } from './sessionHarness';

const profile = (fields: Partial<NamedAgentProfile>): NamedAgentProfile => ({
  name: 'lead', source: 'user', main: true, disabled: false, routes: [], ...fields,
});
const claude: ExecutorCatalogItem = {
  id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', version: '0.83.0',
  model_binding: 'mapped', thinking_binding: 'unavailable',
  capabilities: { prompt_deliveries: ['preamble'], steer: 'native', permission: { trust_engine_settings: true }, thinking_binding: false,
    negotiated: { agent_version: '0.84.0', fork: false, image: true } },
};

describe('sessionHarnessOf', () => {
  it('is undefined for a native or unknown main profile', () => {
    expect(sessionHarnessOf('lead', [profile({})], [claude])).toBeUndefined();
    expect(sessionHarnessOf('other', [profile({ executor: 'claude-acp' })], [claude])).toBeUndefined();
    expect(sessionHarnessOf(undefined, [profile({ executor: 'claude-acp' })], [claude])).toBeUndefined();
  });

  it('prefers the handshake version and carries the Kiki-subagents flag', () => {
    const harness = sessionHarnessOf('lead', [profile({ executor: 'claude-acp', allow_kiki_subagents: true })], [claude]);
    expect(harness).toMatchObject({ executorId: 'claude-acp', label: 'Claude Code', version: '0.84.0', kikiSubagents: true });
  });

  it('uses the session snapshot after a profile executor change or deletion', () => {
    const session = { executor_id: 'claude-acp', negotiated: { agent_version: 'session-version', image: false }, allow_kiki_subagents: true };
    for (const profiles of [[profile({ executor: 'codex-app-server' })], []]) {
      expect(sessionHarnessOf('lead', profiles, [claude], session)).toMatchObject({
        executorId: 'claude-acp', version: 'session-version', negotiated: { image: false }, kikiSubagents: true,
      });
    }
  });

  it('does not borrow a different session handshake or turn a native binding external', () => {
    expect(sessionHarnessOf('lead', [profile({ executor: 'claude-acp' })], [claude], { executor_id: 'native' })).toBeUndefined();
    expect(sessionHarnessOf('lead', [], [claude], { executor_id: 'claude-acp' })?.negotiated).toBeUndefined();
  });

  it('keeps the raw id when the catalog has not loaded', () => {
    expect(sessionHarnessOf('lead', [profile({ executor: 'grok-acp' })], [])).toMatchObject({ label: 'grok-acp', negotiated: undefined });
  });
});

describe('capability gates', () => {
  it('hides an entry only on an explicit no', () => {
    const harness = sessionHarnessOf('lead', [profile({ executor: 'claude-acp' })], [claude]);
    expect(harnessDenies(harness, 'fork')).toBe(true);
    expect(harnessDenies(harness, 'image')).toBe(false);
    expect(harnessDenies(sessionHarnessOf('lead', [profile({ executor: 'x' })], []), 'fork')).toBe(false);
    expect(harnessDenies(undefined, 'fork')).toBe(false);
  });

  it('flags Codex with Kiki subagents in Full access only', () => {
    const codex = sessionHarnessOf('lead', [profile({ executor: 'codex-app-server', allow_kiki_subagents: true })], []);
    expect(codexRefusesKikiTools(codex, 'yolo')).toBe(true);
    expect(codexRefusesKikiTools(codex, 'manual')).toBe(false);
    const off = sessionHarnessOf('lead', [profile({ executor: 'codex-app-server' })], []);
    expect(codexRefusesKikiTools(off, 'yolo')).toBe(false);
  });
});
