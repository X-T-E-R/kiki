import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import type { ConfigOrigin } from '#/app/config/config';
import { IConfigService } from '#/app/config/config';
import { COMPUTER_CONFIG_SECTION } from '#/app/computer/configSection';
import type { ExperimentalFeatureState } from '#/app/flag/flag';
import { IFlagService } from '#/app/flag/flag';
import { MEMORY_SECTION } from '#/app/memory/configSection';
import { OPTIONAL_CAPABILITY_DOCUMENT_SCOPE, optionalCapabilityDocumentKey } from '#/app/optionalCapability/admit';
import { OPTIONAL_CAPABILITIES_SECTION } from '#/app/optionalCapability/configSection';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { OptionalCapabilityPolicyService } from '#/app/optionalCapability/policyService';
import { THREAD_COMMUNICATION_SECTION } from '#/app/threadCommunication/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

type OriginMap = Record<string, ConfigOrigin>;

let disposables: DisposableStore;
let ix: TestInstantiationService;
let origins: Record<string, OriginMap>;
let values: Record<string, unknown>;
let browser: { enabled: boolean; source: ExperimentalFeatureState['source'] } | undefined;
let docs: Map<string, unknown>;
let failSet: boolean;
let hijackRevision: number | undefined;

function flagState(): ExperimentalFeatureState | undefined {
  if (browser === undefined) return undefined;
  return {
    id: NATIVE_BROWSER_FLAG_ID,
    title: 'Native browser control',
    description: '',
    surface: 'core',
    env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER',
    defaultEnabled: true,
    enabled: browser.enabled,
    source: browser.source,
  };
}

function policy(): IOptionalCapabilityPolicy {
  return ix.get(IOptionalCapabilityPolicy);
}

function row(sessionId: string, id: string) {
  return policy().readSession(sessionId).then((view) => view.rows.find((entry) => entry.id === id));
}

describe('OptionalCapabilityPolicyService', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
    origins = {};
    values = {};
    browser = { enabled: true, source: 'default' };
    docs = new Map();
    failSet = false;
    hijackRevision = undefined;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          origins: (domain: string) => {
            const map = origins[domain];
            if (map === undefined) return {};
            return map;
          },
          get: ((domain: string) => values[domain]) as IConfigService['get'],
        });
        reg.definePartialInstance(IFlagService, { explain: () => flagState() });
        reg.definePartialInstance(IAtomicDocumentStore, {
          get: (async (_scope: string, key: string) => docs.get(key)) as IAtomicDocumentStore['get'],
          set: (async (_scope: string, key: string, value: { revision: number }) => {
            if (hijackRevision !== undefined) {
              docs.set(key, { ...(value as object), revision: hijackRevision });
              const current = policy() as unknown as { cache: Map<string, { revision: number }> };
              current.cache.set(key, { ...(value as object), revision: hijackRevision } as { revision: number });
              hijackRevision = undefined;
              throw new Error('store failed after a later revision');
            }
            if (failSet) {
              failSet = false;
              throw new Error('store failed');
            }
            docs.set(key, value);
          }) as IAtomicDocumentStore['set'],
        });
        reg.define(IOptionalCapabilityPolicy, OptionalCapabilityPolicyService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('keeps factory thread allowed and default-off, and a user false as hard-off', async () => {
    const factory = policy().globalState('thread');
    expect(factory).toMatchObject({ allowed: true, defaultOn: false, origin: 'default', unresolved: false });
    origins[THREAD_COMMUNICATION_SECTION] = { enabled: 'home' };
    values[THREAD_COMMUNICATION_SECTION] = { enabled: false };
    expect(policy().globalState('thread')).toMatchObject({ allowed: false, defaultOn: false, origin: 'home' });
    values[THREAD_COMMUNICATION_SECTION] = { enabled: true };
    expect(policy().globalState('thread')).toMatchObject({ allowed: true, defaultOn: true, origin: 'home' });
  });

  it('reports an unreadable origin instead of opening, including an unreadable defaults map', () => {
    origins[OPTIONAL_CAPABILITIES_SECTION] = { 'web.allowed': 'unreadable' as ConfigOrigin };
    values[OPTIONAL_CAPABILITIES_SECTION] = { web: { allowed: true }, defaults: { web: true } };
    expect(policy().globalState('web')).toMatchObject({ unresolved: true, allowed: false, origin: 'unreadable' });
    origins[OPTIONAL_CAPABILITIES_SECTION] = { 'defaults.memory': 'unreadable' as ConfigOrigin };
    expect(policy().globalState('memory')).toMatchObject({ unresolved: true, allowed: false });
  });

  it('gives web a real allow bit and lets the defaults map override legacy default-on', () => {
    expect(policy().globalState('web')).toMatchObject({ allowed: true, defaultOn: true, origin: 'default' });
    origins[OPTIONAL_CAPABILITIES_SECTION] = { 'web.allowed': 'home', 'defaults.web': 'home' };
    values[OPTIONAL_CAPABILITIES_SECTION] = { web: { allowed: false }, defaults: { web: false } };
    expect(policy().globalState('web')).toMatchObject({ allowed: false, defaultOn: false, origin: 'home' });
    values[OPTIONAL_CAPABILITIES_SECTION] = { web: { allowed: true }, defaults: { web: false } };
    expect(policy().globalState('web')).toMatchObject({ allowed: true, defaultOn: false });
  });

  it('rejects session on when the capability is hard-off and does not write', async () => {
    origins[MEMORY_SECTION] = { enabled: 'home' };
    values[MEMORY_SECTION] = { enabled: false };
    await expect(policy().setChoice('s1', 'memory', 'on')).rejects.toBeInstanceOf(Error2);
    await expect(policy().setChoice('s1', 'memory', 'on')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID, details: { reason: 'allowed_off' } });
    expect(docs.size).toBe(0);
    const view = await policy().readSession('s1');
    expect(view.revision).toBe(0);
    expect(view.rows.find((entry) => entry.id === 'memory')).toMatchObject({ choice: 'inherit', source: 'off', effective: false });
  });

  it('rolls a failed write back and keeps a later revision', async () => {
    await policy().setChoice('s1', 'web', 'off');
    failSet = true;
    await expect(policy().setChoice('s1', 'web', 'on')).rejects.toThrow('store failed');
    expect(await row('s1', 'web')).toMatchObject({ choice: 'off' });
    const stored = docs.get(optionalCapabilityDocumentKey('local', 's1')) as { revision: number; overrides: { web?: string } };
    expect(stored.revision).toBe(1);
    expect(stored.overrides.web).toBe('off');
    hijackRevision = 9;
    await expect(policy().setChoice('s1', 'browser', 'off')).rejects.toThrow('later revision');
    const after = await policy().readSession('s1');
    expect(after.revision).toBe(9);
    expect(after.rows.find((entry) => entry.id === 'web')?.choice).toBe('off');
  });

  it('admits a child grant and a declared name, and keeps workspace memory hard-off', async () => {
    origins[OPTIONAL_CAPABILITIES_SECTION] = { 'defaults.thread': 'default' };
    policy().retain('s1', 'child', { workspaceId: 'w', agentKind: 'child', toolsSource: 'declared', declaredTools: ['ThreadSend'], taskTools: ['WebSearch'] });
    await policy().setChoice('s1', 'thread', 'off');
    await policy().setChoice('s1', 'web', 'off');
    expect(policy().admit('thread', { sessionId: 's1', workspaceId: 'w', agentId: 'child' }).admitted).toBe(false);
    expect(policy().admit('web', { sessionId: 's1', workspaceId: 'w', agentId: 'child' }).admitted).toBe(true);
    expect(policy().admit('web', { sessionId: 's1', workspaceId: 'w' }).reason).toBe('session_off');
    policy().release('s1', 'child');
    policy().retain('s1', 'main', { workspaceId: 'w', agentKind: 'main', toolsSource: 'declared', declaredTools: ['ThreadSend'] });
    expect(policy().admit('thread', { sessionId: 's1', workspaceId: 'w', agentId: 'main' }).reason).toBe('session_off');
    await policy().setChoice('s1', 'thread', 'inherit');
    expect(policy().admit('thread', { sessionId: 's1', workspaceId: 'w', agentId: 'main' }).admitted).toBe(true);
    values[MEMORY_SECTION] = { enabled: true, workspaces: { w: false } };
    expect(policy().admit('memory', { sessionId: 's1', workspaceId: 'w', agentId: 'main' }).reason).toBe('workspace_off');
    expect(policy().globalState('computer')).toMatchObject({ allowed: true, defaultOn: true });
    origins[COMPUTER_CONFIG_SECTION] = { enabled: 'env' };
    values[COMPUTER_CONFIG_SECTION] = { enabled: false };
    expect(policy().globalState('computer')).toMatchObject({ allowed: false, hostLocked: true, origin: 'env' });
    expect(policy().anyMayUse('thread')).toBe(true);
    policy().release('s1', 'main');
    expect(policy().anyMayUse('thread')).toBe(false);
    expect(docs.get(optionalCapabilityDocumentKey('local', 's1'))).toBeDefined();
    expect(OPTIONAL_CAPABILITY_DOCUMENT_SCOPE).toBe('session-optional-capabilities');
  });
});
