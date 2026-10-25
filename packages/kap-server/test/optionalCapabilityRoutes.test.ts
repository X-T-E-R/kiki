import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, ISessionManager, type ISessionContext, type Scope } from '@kiki/agent-core-v2';
import { NATIVE_BROWSER_FLAG_ID } from '@kiki/agent-core-v2/app/browser/flag';
import type { ConfigOrigin } from '@kiki/agent-core-v2/app/config/config';
import { IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { COMPUTER_CONFIG_SECTION } from '@kiki/agent-core-v2/app/computer/configSection';
import type { ExperimentalFeatureState } from '@kiki/agent-core-v2/app/flag/flag';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import { MEMORY_SECTION } from '@kiki/agent-core-v2/app/memory/configSection';
import { optionalCapabilityDocumentKey } from '@kiki/agent-core-v2/app/optionalCapability/admit';
import { OPTIONAL_CAPABILITIES_SECTION } from '@kiki/agent-core-v2/app/optionalCapability/configSection';
import { OptionalCapabilityPolicyService } from '@kiki/agent-core-v2/app/optionalCapability/policyService';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { SessionOptionalCapabilityService } from '@kiki/agent-core-v2/session/optionalCapability/sessionOptionalCapabilityService';
import { THREAD_COMMUNICATION_SECTION } from '@kiki/agent-core-v2/app/threadCommunication/configSection';
import { ErrorCode } from '@kiki/protocol';

import { registerOptionalCapabilityRoutes } from '../src/routes/optionalCapabilities';

type OriginMap = Record<string, ConfigOrigin>;

describe('optional capability session routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  function mount() {
    const app = Fastify();
    apps.push(app);
    const origins: Record<string, OriginMap> = {};
    const values: Record<string, unknown> = {};
    const docs = new Map<string, unknown>();
    let failSet = false;
    let hijackRevision: number | undefined;
    const browser = { enabled: true, source: 'default' as ExperimentalFeatureState['source'] };
    const policy = new OptionalCapabilityPolicyService(
      {
        origins: (domain: string) => origins[domain] ?? {},
        get: ((domain: string) => values[domain]) as IConfigService['get'],
      } as IConfigService,
      {
        explain: (id: string) => id === NATIVE_BROWSER_FLAG_ID ? {
          id, title: 'Native browser control', description: '', surface: 'core', env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER', defaultEnabled: true, enabled: browser.enabled, source: browser.source,
        } : undefined,
      } as IFlagService,
      {
        get: async (_scope: string, key: string) => docs.get(key),
        set: async (_scope: string, key: string, value: { revision: number }) => {
          if (hijackRevision !== undefined) {
            const revision = hijackRevision;
            hijackRevision = undefined;
            const poked = { ...value, revision };
            docs.set(key, poked);
            (policy as unknown as { cache: Map<string, unknown> }).cache.set(key, poked);
            throw new Error('store failed after a later revision');
          }
          if (failSet) {
            failSet = false;
            throw new Error('store failed');
          }
          docs.set(key, value);
        },
      } as IAtomicDocumentStore,
    );
    const sessions = new Map<string, SessionOptionalCapabilityService>();
    const sessionFor = (sessionId: string) => {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) return existing;
      const created = new SessionOptionalCapabilityService({ sessionId } as ISessionContext, { effectiveMode: () => 'reply' } as never, policy);
      sessions.set(sessionId, created);
      return created;
    };
    const core = {
      accessor: {
        get(token: unknown) {
          if (token === ISessionManager) {
            return {
              acquire: async (sessionId: string) => {
                if (sessionId === 'missing') return undefined;
                const service = sessionFor(sessionId);
                return { handle: { accessor: { get: () => service } }, dispose: async () => {} };
              },
            };
          }
          throw new Error(`unexpected core service ${String(token)}`);
        },
      },
    } as unknown as Scope;
    registerOptionalCapabilityRoutes(app as unknown as Parameters<typeof registerOptionalCapabilityRoutes>[0], core);
    return { app, policy, origins, values, docs, armFail: () => { failSet = true; }, armHijack: (revision: number) => { hijackRevision = revision; } };
  }

  async function post(app: ReturnType<typeof Fastify>, sessionId: string, body: { id: string; choice: string }) {
    return app.inject({ method: 'POST', url: `/sessions/${sessionId}/optional-capabilities`, payload: body });
  }

  async function read(app: ReturnType<typeof Fastify>, sessionId: string) {
    const response = await app.inject({ method: 'GET', url: `/sessions/${sessionId}/optional-capabilities` });
    expect(response.statusCode).toBe(200);
    return response.json() as { code: number; data: { revision: number; host_id: string; rows: { id: string; choice: string; effective: boolean; source: string; reason: string }[] } };
  }

  function row(body: { data: { rows: { id: string }[] } }, id: string) {
    return body.data.rows.find((entry) => entry.id === id);
  }

  it('rejects a hard-off session on without writing, and leaves a default-off main closed', async () => {
    const harness = mount();
    harness.origins[MEMORY_SECTION] = { enabled: 'home' };
    harness.values[MEMORY_SECTION] = { enabled: false };
    const denied = await post(harness.app, 's1', { id: 'memory', choice: 'on' });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      details: { reason: 'allowed_off' },
    });
    expect(harness.docs.size).toBe(0);
    const view = await read(harness.app, 's1');
    expect(view.data.host_id).toBe('local');
    expect(row(view, 'memory')).toMatchObject({ choice: 'inherit', effective: false, source: 'off', reason: 'allowed_off' });
    expect(row(view, 'thread')).toMatchObject({ choice: 'inherit', effective: true, source: 'default', reason: 'admitted' });
    expect(row(view, 'web')).toMatchObject({ choice: 'inherit', effective: true, source: 'default', reason: 'admitted' });
  });

  it('keeps a declared profile from opening main, and a child grant from changing the session row', async () => {
    const harness = mount();
    const off = await post(harness.app, 's1', { id: 'thread', choice: 'off' });
    expect(off.statusCode).toBe(200);
    expect(off.json().code).toBe(0);
    const webOff = await post(harness.app, 's1', { id: 'web', choice: 'off' });
    expect(webOff.json().code).toBe(0);
    harness.policy.retain('s1', 'main', { workspaceId: 'w', agentKind: 'main', toolsSource: 'declared', declaredTools: ['ThreadSend', 'WebSearch'] });
    harness.policy.retain('s1', 'child', { workspaceId: 'w', agentKind: 'child', taskTools: ['WebSearch'] });
    expect(harness.policy.admit('thread', { sessionId: 's1', workspaceId: 'w', agentId: 'main' }).reason).toBe('session_off');
    expect(harness.policy.admit('web', { sessionId: 's1', workspaceId: 'w', agentId: 'main' }).reason).toBe('session_off');
    expect(harness.policy.admit('web', { sessionId: 's1', workspaceId: 'w', agentId: 'child' }).admitted).toBe(true);
    expect(harness.policy.admit('thread', { sessionId: 's1', workspaceId: 'w', agentId: 'child' }).reason).toBe('session_off');
    const view = await read(harness.app, 's1');
    expect(row(view, 'thread')).toMatchObject({ choice: 'off', effective: false, source: 'session', reason: 'session_off' });
    expect(row(view, 'web')).toMatchObject({ choice: 'off', effective: false, source: 'session', reason: 'session_off' });
    const other = await read(harness.app, 's2');
    expect(row(other, 'web')).toMatchObject({ choice: 'inherit', effective: true, reason: 'admitted' });
    expect(row(other, 'thread')).toMatchObject({ choice: 'inherit', effective: true, source: 'default', reason: 'admitted' });
  });

  it('restores a failed write and keeps a later revision that landed during the failure', async () => {
    const harness = mount();
    expect((await post(harness.app, 's1', { id: 'web', choice: 'off' })).json().code).toBe(0);
    harness.armFail();
    const failed = await post(harness.app, 's1', { id: 'web', choice: 'on' });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(row(await read(harness.app, 's1'), 'web')).toMatchObject({ choice: 'off' });
    const stored = harness.docs.get(optionalCapabilityDocumentKey('local', 's1')) as { revision: number; overrides: { web?: string } };
    expect(stored.revision).toBe(1);
    expect(stored.overrides.web).toBe('off');
    harness.armHijack(9);
    const late = await post(harness.app, 's1', { id: 'browser', choice: 'off' });
    expect(late.statusCode).toBeGreaterThanOrEqual(500);
    const after = await read(harness.app, 's1');
    expect(after.data.revision).toBe(9);
    expect(row(after, 'web')).toMatchObject({ choice: 'off' });
    expect(row(after, 'browser')).toMatchObject({ choice: 'off' });
    const followed = await post(harness.app, 's1', { id: 'computer', choice: 'off' });
    expect(followed.json().code).toBe(0);
    expect((await read(harness.app, 's1')).data.revision).toBe(10);
  });

  it('answers a missing session without creating a document', async () => {
    const harness = mount();
    const response = await harness.app.inject({ method: 'GET', url: '/sessions/missing/optional-capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, msg: 'Session was not found' });
    expect(harness.docs.size).toBe(0);
    expect(ErrorCodes.REQUEST_INVALID).toBe('request.invalid');
  });
});
