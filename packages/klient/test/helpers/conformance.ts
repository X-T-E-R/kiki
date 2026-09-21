/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IMcpManagementService } from '@kiki/agent-core-v2/app/mcpManagement/mcpManagement';
import { IAgentGoalService } from '@kiki/agent-core-v2/agent/goal/goal';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Service } from '@kiki/agent-core-v2/_base/di/service';
import { CommandContribution } from '@kiki/agent-core-v2/agent/command/commandContribution';
import { IFeatureManager } from '@kiki/agent-core-v2/app/feature/featureManager';
import { getLiveSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import { IAgentPromptService, reservePrompt } from '@kiki/agent-core-v2/agent/prompt/prompt';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';
import { ISessionActivityView } from '@kiki/agent-core-v2/session/sessionActivity/sessionActivity';

import type { Klient } from '../../src/index.js';
import type { TestEngine } from './engine.js';

export interface KlientConformanceTarget {
  readonly klient: Klient;
  /**
   * The in-process engine's App scope. Both transports boot the engine
   * in-process, so the suite can assemble dynamic units (e.g. contributed
   * commands) through the production `IFeatureManager` path.
   */
  readonly app: TestEngine['app'];
  cleanup(): Promise<void>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function defineKlientConformance(
  transport: string,
  makeTarget: () => Promise<KlientConformanceTarget>,
): void {
  describe(`klient conformance: ${transport}`, () => {
    let target: KlientConformanceTarget;

    beforeAll(async () => {
      target = await makeTarget();
    });

    afterAll(async () => {
      await target.cleanup();
    });

    if (transport === 'memory' || transport === 'ipc') {
      it('explicitly rejects the HTTP-only terminal capability', async () => {
        await expect(target.klient.terminal.listTerminals('s1')).rejects.toThrow('unsupported');
        await expect(target.klient.terminal.createTerminal('s1')).rejects.toThrow('unsupported');
        await expect(target.klient.terminal.terminalAttach('s1', 't1')).rejects.toThrow('unsupported');
        expect(() => target.klient.terminal.onTerminalSignal(() => undefined)).toThrow('unsupported');
      });
    }

    it('env() aggregates the host snapshot', async () => {
      const env = await target.klient.global.env();
      expect(env.platform).toBe(process.platform);
      expect(env.homeDir.length).toBeGreaterThan(0);
      expect(env.clientVersion.length).toBeGreaterThan(0);
    });

    it('workspaces round-trip through create/get/update/list/delete', async () => {
      const workspaces = target.klient.global.workspaces;
      const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
      expect(created.id.length).toBeGreaterThan(0);
      expect(created.pinned).toBe(false);

      const fetched = await workspaces.get(created.id);
      expect(fetched?.name).toBe('conformance');
      expect(fetched?.pinned).toBe(false);

      const pinned = await workspaces.update({
        id: created.id,
        patch: { name: 'conformance-2', pinned: true },
      });
      expect(pinned?.name).toBe('conformance-2');
      expect(pinned?.pinned).toBe(true);
      expect((await workspaces.get(created.id))?.pinned).toBe(true);

      const list = await workspaces.list();
      expect(list.find((w) => w.id === created.id)?.pinned).toBe(true);

      const unpinned = await workspaces.update({ id: created.id, patch: { pinned: false } });
      expect(unpinned?.pinned).toBe(false);
      expect((await workspaces.get(created.id))?.pinned).toBe(false);

      await workspaces.delete(created.id);
      expect(await workspaces.get(created.id)).toBeUndefined();
    });

    it('sessions index responds with a page shape', async () => {
      const page = await target.klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
      const count = await target.klient.global.sessions.countActive(['no-such-workspace']);
      expect(typeof count).toBe('number');
    });

    it('peer threads preserve cross-workspace refs across list/read/send/wait and overrides', async () => {
      const rootA = await mkdtemp(join(tmpdir(), 'klient-conf-thread-a-'));
      const rootB = await mkdtemp(join(tmpdir(), 'klient-conf-thread-b-'));
      const source = await target.klient.global.sessions.create({ workDir: rootA, title: 'source' });
      const destination = await target.klient.global.sessions.create({ workDir: rootB, title: 'target' });
      try {
        const sourceSummary = await target.klient.global.sessions.get(source.id);
        const targetSummary = await target.klient.global.sessions.get(destination.id);
        expect(sourceSummary).toBeDefined();
        expect(targetSummary).toBeDefined();
        const hostId = await target.klient.global.threads.hostId();
        const sourceRef = {
          hostId,
          workspaceId: sourceSummary!.workspaceId,
          sessionId: source.id,
        };
        const targetRef = {
          hostId,
          workspaceId: targetSummary!.workspaceId,
          sessionId: destination.id,
        };
        expect(sourceRef.workspaceId).not.toBe(targetRef.workspaceId);

        const listed = await target.klient.global.threads.list({
          workspaceId: targetRef.workspaceId,
        });
        expect(listed.threads.some((thread) => thread.ref.sessionId === destination.id)).toBe(true);

        await expect(target.klient.global.threads.read({ thread: targetRef })).resolves.toMatchObject({
          thread: targetRef,
          turns: [],
        });
        await expect(
          target.klient.global.threads.wait({
            threads: [{ thread: targetRef }],
            timeoutMs: 0,
          }),
        ).resolves.toMatchObject({ timedOut: true });

        const sent = await target.klient.global.threads.send({
          target: targetRef,
          content: 'peer conformance message',
          idempotencyKey: `${transport}-thread-message`,
        });
        expect(sent.messageId.length).toBeGreaterThan(0);
        expect(['pending', 'delivered', 'undeliverable']).toContain(sent.delivery);
        await expect(
          target.klient.global.threads.send({
            target: { ...targetRef, hostId: 'another-host' },
            content: 'invalid cross-host send',
            idempotencyKey: `${transport}-cross-host`,
          }),
        ).rejects.toMatchObject({
          name: 'RPCError',
          code: 40929,
          reason: 'thread.cross_host',
        });

        await target.klient.global.threads.setWorkspaceOverride(targetRef.workspaceId, false);
        await expect(
          target.klient.global.threads.getWorkspaceOverride(targetRef.workspaceId),
        ).resolves.toBe(false);
        await expect(
          target.klient.global.threads.isWorkspaceEnabled(targetRef.workspaceId),
        ).resolves.toBe(false);
        await target.klient.global.threads.clearWorkspaceOverride(targetRef.workspaceId);
        await expect(
          target.klient.global.threads.getWorkspaceOverride(targetRef.workspaceId),
        ).resolves.toBeUndefined();
      } finally {
        await target.klient.session(source.id).close();
        await target.klient.session(destination.id).close();
        await rm(rootA, { recursive: true, force: true });
        await rm(rootB, { recursive: true, force: true });
      }
    });

    it('creates a titled session through implicit workspace materialization', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance session',
      });

      try {
        expect(created).toMatchObject({
          title: 'conformance session',
          cwd: process.cwd(),
          archived: false,
        });
        expect(created.id.length).toBeGreaterThan(0);
        const facade = target.klient.session(created.id);
        expect(await facade.status()).toBe('idle');
        const live = getLiveSessionById(target.app.accessor, created.id)!;
        const interactions = live.accessor.get(ISessionInteractionService);
        const activity = live.accessor.get(ISessionActivityView);
        const question = interactions.enqueue({ kind: 'question', payload: {} });
        expect(activity.state().pendingInteraction).toBe('question');
        expect(await facade.status()).toBe('awaiting_question');
        const approval = interactions.enqueue({ kind: 'approval', payload: {} });
        expect(activity.state().pendingInteraction).toBe('approval');
        expect(await facade.status()).toBe('awaiting_approval');
        interactions.respond(approval.id, {});
        expect(await facade.status()).toBe('awaiting_question');
        interactions.respond(question.id, {});
        expect(activity.state().pendingInteraction).toBe('none');
        expect(await facade.status()).toBe('idle');
        expect(await target.klient.global.sessions.get(created.id)).toMatchObject({
          id: created.id,
          title: 'conformance session',
        });
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('observes an authoritative baseline and changes without a caller-side subscribe delay', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(), title: 'observe baseline',
      });
      const session = target.klient.session(created.id);
      const live = getLiveSessionById(target.app.accessor, created.id)!;
      const interactions = live.accessor.get(ISessionInteractionService);
      const initial = interactions.enqueue({ kind: 'question', payload: {} });
      const snapshots: Array<{ title: string | undefined; ids: string[] }> = [];
      const errors: Error[] = [];
      const errorSub = session.events.onError((error) => errors.push(error));
      const observation = session.events.observe({
        events: ['metadata.changed', 'interactions.changed'],
        read: async () => {
          const [meta, pending] = await Promise.all([session.get(), session.interactions.list()]);
          return { title: meta.title, ids: pending.map((item) => item.id) };
        },
      }, (snapshot) => snapshots.push(snapshot));
      try {
        await waitFor(() => snapshots.length > 0, 5_000);
        expect(snapshots.at(-1)).toEqual({ title: 'observe baseline', ids: [initial.id] });
        interactions.respond(initial.id, {});
        const next = interactions.enqueue({ kind: 'approval', payload: {} });
        await session.setTitle('observe latest');
        await waitFor(() => snapshots.at(-1)?.title === 'observe latest' &&
          snapshots.at(-1)?.ids.join() === next.id, 5_000);
        expect(errors).toEqual([]);
        interactions.respond(next.id, {});
        await waitFor(() => snapshots.at(-1)?.ids.length === 0, 5_000);
      } finally {
        observation.dispose();
        errorSub.dispose();
        await session.close();
      }
    });

    it('session createChild tags child markers while fork stays untagged', async () => {
      const parent = await target.klient.global.sessions.create({
        sessionId: 'conformance-parent',
        workDir: process.cwd(),
        title: 'conformance parent',
      });
      try {
        expect(parent.id).toBe('conformance-parent');
        const child = await target.klient.session(parent.id).createChild({ newSessionId: 'conformance-child' });
        try {
          expect(child.id).toBe('conformance-child');
          expect(child.custom?.['parent_session_id']).toBe(parent.id);
          expect(child.custom?.['child_session_kind']).toBe('child');
          expect(child.title).toBe('Child: conformance parent');
        } finally {
          await target.klient.session(child.id).close();
        }
        const forked = await target.klient.session(parent.id).fork({
          newSessionId: 'conformance-fork', metadata: { label: 'fork metadata' },
        });
        try {
          expect(forked.id).toBe('conformance-fork');
          expect(forked.custom?.['label']).toBe('fork metadata');
          expect(forked.custom?.['parent_session_id']).toBeUndefined();
          expect(forked.custom?.['child_session_kind']).toBeUndefined();
        } finally {
          await target.klient.session(forked.id).close();
        }
        await expect(target.klient.session(parent.id).fork({ turnIndex: -1 })).rejects.toThrow();
      } finally {
        await target.klient.session(parent.id).close();
      }
    });

    it('session skills.list returns the workspace skills as summaries', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skills-'));
      try {
        await mkdir(join(workDir, '.git'), { recursive: true });
        await mkdir(join(workDir, '.kiki', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kiki', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const skills = await target.klient.session(created.id).skills.list();
          expect(skills.find((skill) => skill.name === 'conf-skill')).toMatchObject({
            name: 'conf-skill',
            description: 'conformance fixture skill',
            source: 'project',
          });
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('providers.set/get/delete works and emits kosong.providers.changed', async () => {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const errors: Error[] = [];
      target.klient.events.onError((error) => {
        errors.push(error);
      });
      const sub = target.klient.events.on('kosong.providers.changed', (event) => {
        events.push(event);
      });
      // Give the subscription a wire round-trip (memory is synchronous; ipc
      // and http's lazy WS need a frame exchange).
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const name = '__klient_conformance__';
      try {
        expect(() =>
          target.klient.global.kosong.addProvider(name, {
            type: 'openai',
            auth: { method: 'api-key', apiKey: 'conf-key' },
            requestAttribution: 'none',
          } as never),
        ).toThrow(/requestAttribution was removed/u);
        await target.klient.global.kosong.addProvider(name, {
          type: 'openai',
          auth: { method: 'api-key', apiKey: 'conf-key' },
          requestIdentity: {
            overrides: { client: { userAgent: 'host' } },
          },
        });
        const got = await target.klient.global.kosong.getProvider(name);
        expect(got.has_api_key).toBe(true);
        expect(got.request_identity).toEqual({
          overrides: { client: { user_agent: 'host' } },
        });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(name)),
          5_000,
        );
      } finally {
        await target.klient.global.kosong.removeProvider(name);
        sub.dispose();
      }
      expect(errors).toEqual([]);
    });

    it('config reads respond', async () => {
      const all = await target.klient.global.config.getAll();
      expect(typeof all).toBe('object');
      expect(Array.isArray(await target.klient.global.config.diagnostics())).toBe(true);
    });

    it('config requestIdentity replaces and clears an authored global layer', async () => {
      const config = target.klient.global.config;
      const before = await config.inspect('requestIdentity');
      try {
        await config.replace({
          domain: 'requestIdentity',
          value: { overrides: { client: { userAgent: 'host' } } },
        });
        expect((await config.get('requestIdentity'))).toEqual({
          overrides: { client: { userAgent: 'host' } },
        });
        expect((await config.inspect('requestIdentity')).userValue).toEqual({
          overrides: { client: { userAgent: 'host' } },
        });
        await config.replace({ domain: 'requestIdentity', value: undefined });
        expect((await config.inspect('requestIdentity')).userValue).toBeUndefined();
      } finally {
        await config.replace({ domain: 'requestIdentity', value: before.userValue });
      }
    });

    it('config replaceSections writes several domains and clears undefined ones', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      try {
        await config.replaceSections({
          sections: {
            providers: {
              ...beforeProviders.userValue,
              'conf-provider': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
            },
            models: {
              ...beforeModels.userValue,
              'conf-provider/m1': { provider: 'conf-provider', model: 'm1', maxContextSize: 100 },
            },
            defaultModel: 'conf-provider/m1',
          },
        });
        expect((await config.inspect<string>('defaultModel')).userValue).toBe('conf-provider/m1');

        // A domain mapped to `undefined` is cleared; domains absent from the
        // sections record are left untouched.
        await config.replaceSections({ sections: { defaultModel: undefined } });
        expect((await config.inspect<string>('defaultModel')).userValue).toBeUndefined();
        const providers = await config.inspect<Record<string, unknown>>('providers');
        expect(providers.userValue?.['conf-provider']).toBeDefined();
      } finally {
        await config.replaceSections({
          sections: { providers: beforeProviders.userValue, models: beforeModels.userValue },
        });
      }
    });

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
    });

    it('files save/get/delete round-trips bytes through the file store', async () => {
      const files = target.klient.global.files;
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const meta = await files.save({
        data: bytes,
        filename: 'conformance.bin',
        mimeType: 'application/octet-stream',
        expiresInSec: 3600,
      });
      expect(meta.id.startsWith('f_')).toBe(true);
      expect(meta.name).toBe('conformance.bin');
      expect(meta.media_type).toBe('application/octet-stream');
      expect(meta.size).toBe(bytes.length);
      expect(typeof meta.expires_at).toBe('string');

      const downloaded = await files.get(meta.id);
      expect(downloaded.meta).toEqual(meta);
      expect([...downloaded.data]).toEqual([...bytes]);

      await files.delete(meta.id);
      // Both transports surface a deleted/expired upload as the same public
      // RPCError code, never the engine's raw error type.
      await expect(files.get(meta.id)).rejects.toMatchObject({ name: 'RPCError', code: 40404 });
    });

    it('kosong lists models/providers and anonymous provider round-trips', async () => {
      const kosong = target.klient.global.kosong;
      expect(Array.isArray(await kosong.listModels())).toBe(true);
      expect(Array.isArray(await kosong.listProviders())).toBe(true);

      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const sub = target.klient.events.on('kosong.models.changed', (event) => {
        events.push(event);
      });
      // See kosong.providers.changed above — give the subscription a wire round-trip.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const id = '__klient_conformance__';
      try {
        await kosong.addProvider({
          id,
          model: 'conf-model',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          auth: { method: 'api-key', apiKey: 'conf-key' },
          requestIdentity: { overrides: { request: { logicalId: 'none' } } },
        });
        expect((await kosong.listModels()).find((model) => model.id === id)?.request_identity)
          .toEqual({ overrides: { request: { logical_id: 'none' } } });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(id)),
          5_000,
        );
      } finally {
        await kosong.removeProvider(id);
        sub.dispose();
      }
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
    });

    it('global mcp round-trips user-level server CRUD', async () => {
      const mcp = target.klient.global.mcp;
      const cwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-crud-'));
      try {
        expect(await mcp.list({ cwd })).toEqual([]);

        const added = await mcp.add({
          cwd,
          server: {
            name: 'conf-mcp',
            transport: 'stdio',
            command: 'conf-command',
            env: { TOKEN: 'secret' },
          },
        });
        const entry = added.find((server) => server.name === 'conf-mcp');
        // Mutable (user-level) entries carry the full config for edit prefill.
        expect(entry).toMatchObject({
          name: 'conf-mcp',
          source: 'global',
          mutable: true,
          config: { transport: 'stdio', command: 'conf-command', env: { TOKEN: 'secret' } },
        });

        await mcp.update({
          cwd,
          server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command-2' },
        });
        expect((await mcp.get({ name: 'conf-mcp', cwd })).config).toMatchObject({
          command: 'conf-command-2',
        });

        await mcp.remove({ name: 'conf-mcp', cwd });
        expect(await mcp.list({ cwd })).toEqual([]);
        await expect(mcp.get({ name: 'conf-mcp', cwd })).rejects.toMatchObject({
          name: 'RPCError',
          code: 40408,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('global mcp probes an inline server config without persisting it', async () => {
      const mcp = target.klient.global.mcp;
      // Inline probe against a scratch cwd: the binary runs but never
      // speaks MCP, so the connection test reports a clean failure.
      const probeCwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-probe-'));
      try {
        const probe = await mcp.test({
          server: {
            name: 'conf-probe',
            transport: 'stdio',
            command: process.execPath,
            args: ['--version'],
            startupTimeoutMs: 10_000,
          },
          cwd: probeCwd,
        });
        expect(probe.success).toBe(false);
        expect(typeof probe.output).toBe('string');
      } finally {
        await rm(probeCwd, { recursive: true, force: true });
      }
      expect(await mcp.list()).toEqual([]);
    });

    it('global mcp resolves locators and classifies auth offline', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command' },
      });
      try {
        // The locator surface: resolve a legacy name, inspect nothing/all.
        expect(await mcp.resolveByName({ name: 'conf-mcp' })).toEqual({
          source: 'global',
          name: 'conf-mcp',
        });
        expect(await mcp.inspect({ targets: [] })).toEqual([]);
        // An omitted `targets` ahead of a present options arg must mean "the
        // whole catalog" on every transport (ipc encodes it as `null`).
        expect((await mcp.inspect({})).map((i) => i.runtimeName)).toContain('conf-mcp');
        await expect(
          mcp.inspect({ targets: [{ source: 'global', name: 'conf-missing' }] }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40408 });

        // Offline auth classification of a stdio server needs no probe, and
        // an OAuth flow against a stdio target is request.invalid → 40001.
        expect(await mcp.authStatuses()).toEqual([
          { name: 'conf-mcp', authStatus: 'not-applicable' },
        ]);
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-mcp' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-mcp' });
      }
    });

    it('cancels only the MCP authorization waiter through the transport', async () => {
      const management = target.app.accessor.get(IMcpManagementService);
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      let observedSignal: AbortSignal | undefined;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const complete = vi.spyOn(management, 'completeServerAuth').mockImplementation(async (_input, options) => {
        observedSignal = options?.signal;
        observedSignal?.addEventListener('abort', release, { once: true });
        entered();
        await waiting;
        observedSignal?.removeEventListener('abort', release);
        observedSignal?.throwIfAborted();
      });
      const cancel = vi.spyOn(management, 'cancelServerAuth');
      const result = target.klient.global.mcp.completeAuth(
        { flowId: 'synthetic-waiter' }, { signal: controller.signal },
      ).then(() => undefined, (error: unknown) => error);
      try {
        await started;
        expect(observedSignal).toBeDefined();
        controller.abort();
        expect(await result).toBeInstanceOf(Error);
        await waitFor(() => observedSignal?.aborted === true, 2_000);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        release();
        await result;
        complete.mockRestore();
        cancel.mockRestore();
      }
    });

    it('does not start an already aborted MCP authorization wait', async () => {
      const management = target.app.accessor.get(IMcpManagementService);
      const complete = vi.spyOn(management, 'completeServerAuth').mockResolvedValue(undefined);
      const controller = new AbortController();
      controller.abort();
      try {
        await expect(target.klient.global.mcp.completeAuth(
          { flowId: 'synthetic-aborted-waiter' }, { signal: controller.signal },
        )).rejects.toBeDefined();
        expect(complete).not.toHaveBeenCalled();
      } finally {
        complete.mockRestore();
      }
    });

    it('global mcp completeAuth rejects an unknown flowId with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.completeAuth({ flowId: 'conf-unknown-flow' })).rejects.toMatchObject({
        name: 'RPCError',
        code: 40001,
      });
    });

    it('global mcp OAuth failures map to the 40940 wire code on every transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth-failure',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          auth: 'oauth',
        },
      });
      try {
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-oauth-failure' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40940 });
      } finally {
        await mcp.remove({ name: 'conf-oauth-failure' });
      }
    });

    it('global mcp cancelAuth ignores an unknown flowId', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.cancelAuth({ flowId: 'conf-unknown-flow' })).resolves.toBeUndefined();
    });

    it('global mcp resetAuth clears a remote oauth server through the transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: 'oauth',
        },
      });
      try {
        // Invalidate is offline: no stored grant and no network needed.
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-oauth' } }),
        ).resolves.toBeUndefined();
      } finally {
        await mcp.remove({ name: 'conf-oauth' });
      }
    });

    it('global mcp resetAuth rejects a stdio locator with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-stdio', transport: 'stdio', command: 'conf-command' },
      });
      try {
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-stdio' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-stdio' });
      }
    });

    it('preserves archive state on resume and exposes live resource reads', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      try {
        await session.archive();
        expect(await session.resume()).toBe(true);
        expect((await session.get()).archived).toBe(true);
        expect(await session.countPendingBackgroundTasks()).toBe(0);
        expect(await session.nextCronFireAt()).toBeNull();
        await session.drainBackgroundTasks(100);
        await expect(session.drainBackgroundTasks(0)).rejects.toThrow();
        expect(await session.restore()).toBe(true);
        expect((await session.get()).archived).toBe(false);
      } finally {
        await session.close();
      }
      expect(await target.klient.session('missing-resume-session').resume()).toBe(false);
    });

    it('keeps local permission changes local and default changes broadcast', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      const main = session.agent('main');
      await main.getRuntime();
      const live = getLiveSessionById(target.app.accessor, created.id)!;
      const child = await live.accessor.get(IAgentLifecycleService).create({ agentId: 'permission-child' });
      const other = session.agent(child.id);
      try {
        await main.setPermission('manual');
        expect(await other.getPermission()).toBe('manual');
        await main.setPermission('auto', { broadcast: false });
        expect(await main.getPermission()).toBe('auto');
        expect(await other.getPermission()).toBe('manual');
        await main.setPermission('yolo');
        expect(await other.getPermission()).toBe('yolo');
      } finally {
        await session.close();
      }
    });

    it('restores known cold agents before setModel and rejects missing agents', async () => {
      const initialModel = '__klient_restore_initial__';
      const targetModel = '__klient_restore_target__';
      const kosong = target.klient.global.kosong;
      await kosong.addProvider({
        id: initialModel,
        model: initialModel,
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        maxContextSize: 1000,
        auth: { method: 'api-key', apiKey: 'restore-key' },
      });
      await kosong.addProvider({
        id: targetModel,
        model: targetModel,
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        maxContextSize: 1000,
        auth: { method: 'api-key', apiKey: 'restore-key' },
      });
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      const live = getLiveSessionById(target.app.accessor, created.id);
      if (live === undefined) throw new Error('conformance session was not materialized');
      const lifecycle = live.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({
        agentId: 'cold-set-model',
        binding: { profile: 'agent', model: initialModel, thinking: 'off' },
      });
      await lifecycle.remove(child.id);
      try {
        expect(lifecycle.get(child.id)).toBeUndefined();
        expect((await session.agents())[child.id]).toBeDefined();
        await expect(session.agent(child.id).setModel(targetModel)).resolves.toMatchObject({
          model: targetModel,
        });
        expect(lifecycle.get(child.id)).toBeDefined();
        await expect(session.agent(child.id).getModel()).resolves.toBe(targetModel);
        await expect(session.agent('missing-set-model').setModel(targetModel)).rejects.toMatchObject({
          name: 'RPCError',
          code: 40404,
        });
      } finally {
        await session.close();
        await kosong.removeProvider(initialModel);
        await kosong.removeProvider(targetModel);
      }
    });

    it('keeps todo state isolated per agent across the transport', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      const live = getLiveSessionById(target.app.accessor, created.id)!;
      const lifecycle = live.accessor.get(IAgentLifecycleService);
      const main = await lifecycle.create({ agentId: 'main' });
      const child = await lifecycle.create({ agentId: 'todo-child' });
      const todos = live.accessor.get(ISessionTodoService);
      todos.setTodos([{ title: 'main-only', status: 'in_progress' }], main.id);
      todos.setTodos([{ title: 'child-only', status: 'done' }], child.id);
      try {
        await expect(session.todos.get()).resolves.toEqual([
          { title: 'main-only', status: 'in_progress' },
        ]);
        await expect(session.todos.get(child.id)).resolves.toEqual([
          { title: 'child-only', status: 'done' },
        ]);
      } finally {
        await session.close();
      }
    });

    it('pauses, resumes and cancels goals across the transport', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      const agent = session.agent('main');
      try {
        const goal = await agent.createGoal({ objective: 'example lifecycle goal', replace: false });
        expect(await agent.pauseGoal()).toMatchObject({ goalId: goal.goalId, status: 'paused' });
        expect((await agent.getGoal()).goal).toMatchObject({ goalId: goal.goalId, status: 'paused' });
        expect(await agent.resumeGoal()).toMatchObject({ goalId: goal.goalId, status: 'active' });
        expect((await agent.getGoal()).goal).toMatchObject({ goalId: goal.goalId, status: 'active' });
        // Cancellation returns the last snapshot and clears the stored goal.
        expect(await agent.cancelGoal()).toMatchObject({ goalId: goal.goalId, status: 'active' });
        expect((await agent.getGoal()).goal).toBeNull();
      } finally {
        await session.close();
      }
    });

    it('retains the completion snapshot when the engine clears the finished goal', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const session = target.klient.session(created.id);
      const agent = session.agent('main');
      await agent.getRuntime();
      const goals: unknown[] = [];
      const sub = agent.events.on('goal.updated', (event) => {
        if (event.change?.kind === 'completion') goals.push(event.snapshot);
      });
      try {
        await sub.ready;
        const goal = await agent.createGoal({ objective: 'example goal', replace: false });
        expect((await agent.getGoal()).goal?.goalId).toBe(goal.goalId);
        const live = getLiveSessionById(target.app.accessor, created.id)!;
        await live.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentGoalService).markComplete({}, 'system');
        await waitFor(() => goals.length > 0, 2_000);
        expect(goals[0]).toMatchObject({ goalId: goal.goalId, status: 'complete' });
        expect((await agent.getGoal()).goal).toBeNull();
      } finally {
        sub.dispose(); await session.close();
      }
    });

    it('does not silently discard an invalid main binding during session creation', async () => {
      await expect(target.klient.global.sessions.create({
        workDir: process.cwd(), mainAgentBinding: { profile: 'missing-main-profile' },
      })).rejects.toThrow();
    });

    it('attaches prompt events before a terminal submission across the transport', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const agent = target.klient.session(created.id).agent('main');
      await agent.getRuntime();
      const live = getLiveSessionById(target.app.accessor, created.id)!;
      const prompts = live.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentPromptService);
      const hook = prompts.hooks.onBeforeSubmitPrompt.register('conformance-terminal-block', async (event, next) => {
        event.block = true; await next();
      });
      const seen: string[] = [];
      const sub = agent.events.on('prompt.completed', (event) => seen.push(event.promptId));
      try {
        await sub.ready;
        const receipt = await agent.prompt({ input: [{ type: 'text', text: 'blocked example' }], promptId: 'terminal-wire' }, { waitFor: 'terminal' });
        expect(receipt).toMatchObject({ promptId: 'terminal-wire', state: 'blocked' });
        expect(receipt.turnId).toBeUndefined();
        await waitFor(() => seen.includes('terminal-wire'), 2_000);
      } finally {
        sub.dispose(); hook.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('preserves structured terminal launch errors across the transport', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const agent = target.klient.session(created.id).agent('main');
      await agent.getRuntime();
      const live = getLiveSessionById(target.app.accessor, created.id)!;
      const prompts = live.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentPromptService);
      const hook = prompts.hooks.onBeforeSubmitPrompt.register('conformance-terminal-error', async () => {
        throw new Error('launch failed', { cause: new Error('underlying cause') });
      });
      try {
        const receipt = await agent.prompt({ input: [{ type: 'text', text: 'failure example' }] }, { waitFor: 'terminal' });
        expect(receipt).toMatchObject({ state: 'failed', result: { type: 'failed', error: {
          message: 'launch failed', cause: { message: 'underlying cause' },
        } } });
      } finally {
        hook.dispose(); await target.klient.session(created.id).close();
      }
    });

    it('cancels idle compaction through the shared agent contract', async () => {
      const created = await target.klient.global.sessions.create({ workDir: process.cwd() });
      try {
        await expect(target.klient.session(created.id).agent('main').cancelCompaction()).resolves.toBeUndefined();
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent runtime binding is available through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance runtime',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const binding = await agent.getRuntime();
        expect(binding.runtimeId).toBe('local');
        expect(binding.workspaceId.length).toBeGreaterThan(0);
        await expect(agent.switchRuntime('missing-runtime')).rejects.toThrow(/missing-runtime/);
        expect(await agent.getRuntime()).toEqual(binding);
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent commands list and run a contributed command', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance commands',
      });
      const calls: string[] = [];

      // A dynamic App-scope unit contributing one command into the
      // `CommandContribution` collection — the same path a Feature takes.
      class ConformanceCommands extends Service {
        static override readonly name = 'klient-conformance-commands';
        constructor() {
          super();
          this.provide(CommandContribution, {
            name: 'conformance-echo',
            description: 'records its args',
            run: (ctx) => {
              calls.push(ctx.args);
            },
          });
        }
      }

      const featureManager = target.app.accessor.get(IFeatureManager);
      const handle = featureManager.provideUnit(ConformanceCommands);
      try {
        const agent = target.klient.session(created.id).agent('main');

        // Dynamic assembly goes through the cascade — poll until visible.
        let infos = await agent.listCommands();
        const deadline = Date.now() + 5_000;
        while (!infos.some((command) => command.name === 'conformance-echo')) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          infos = await agent.listCommands();
        }
        expect(infos.map((command) => command.name)).toContain('conformance-echo');
        const echo = infos.find((command) => command.name === 'conformance-echo');
        expect(echo).toMatchObject({ name: 'conformance-echo', description: 'records its args' });
        expect(typeof echo?.source).toBe('string');

        await agent.runCommand({ name: 'conformance-echo', args: 'hello commands' });
        expect(calls).toEqual(['hello commands']);

        // Unknown names fail with a coded engine error.
        await expect(agent.runCommand({ name: 'conformance-missing' })).rejects.toThrow(
          /Unknown command/,
        );
      } finally {
        await handle.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('propagates prompt id conflicts with the same 40938 error', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance prompt conflict',
      });
      const session = getLiveSessionById(target.app.accessor, created.id);
      if (session === undefined) throw new Error('conformance session was not materialized');
      const main = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const reservation = reservePrompt(main.accessor.get(IAgentPromptService), 'submission-1');
      try {
        await expect(
          target.klient.session(created.id).agent('main').prompt({
            input: [{ type: 'text', text: 'duplicate' }],
            promptId: 'submission-1',
          }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40938 });
      } finally {
        reservation.dispose();
        await target.klient.session(created.id).close();
      }
    });
  });
}
