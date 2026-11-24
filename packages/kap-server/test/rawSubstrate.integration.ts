import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentMcpService,
  IAgentToolRegistryService,
  IAgentUserToolService,
  IModelCatalogMutationService,
  IRetainedUsageService,
  ISessionMetadata,
  IThreadCommunicationService,
  closeSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/start';
import { authHeaders, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { PROMPT_TOML, type Envelope, usePromptFixture, writeConfigToml } from './helpers/promptFixture';

interface StubLlmRequest {
  readonly model?: string;
  readonly messages?: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  readonly response_format?: unknown;
  readonly tools?: Array<{ type: string; function?: { name: string } }>;
}

interface StubLlmServer {
  readonly url: string;
  readonly requests: StubLlmRequest[];
  close(): Promise<void>;
}

async function startStubLlmServer(
  handler: (req: StubLlmRequest, index: number) => {
    readonly content?: string;
    readonly reasoning?: string;
    readonly toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  },
): Promise<StubLlmServer> {
  const requests: StubLlmRequest[] = [];
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      const parsed = JSON.parse(raw) as StubLlmRequest;
      const index = requests.length;
      requests.push(parsed);
      const reply = handler(parsed, index);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks: string[] = [];
      if (reply.reasoning !== undefined && reply.reasoning.length > 0) {
        chunks.push(
          `data: ${JSON.stringify({
            id: `chatcmpl-${index}`,
            choices: [{ index: 0, delta: { reasoning_content: reply.reasoning }, finish_reason: null }],
          })}\n\n`,
        );
      }
      if (reply.toolCalls !== undefined && reply.toolCalls.length > 0) {
        chunks.push(
          `data: ${JSON.stringify({
            id: `chatcmpl-${index}`,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: reply.toolCalls.map((tc, tcIndex) => ({
                    index: tcIndex,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          })}\n\n`,
        );
      } else {
        chunks.push(
          `data: ${JSON.stringify({
            id: `chatcmpl-${index}`,
            choices: [{ index: 0, delta: { content: reply.content ?? 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
      }
      chunks.push('data: [DONE]\n\n');
      response.end(chunks.join(''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub llm did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

interface StubMcpServer {
  readonly url: string;
  readonly toolCalls: Array<{ name: string; arguments: unknown; meta: unknown }>;
  close(): Promise<void>;
}

async function startStubHttpMcpServer(): Promise<StubMcpServer> {
  const toolCalls: Array<{ name: string; arguments: unknown; meta: unknown }> = [];
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'DELETE') {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      const msg = JSON.parse(raw) as { id?: number | string; method: string; params?: Record<string, unknown> };
      if (msg.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      let result: unknown = {};
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-mcp', version: '1.0.0' },
        };
      } else if (msg.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo_meta',
              description: 'Echoes received metadata',
              inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            },
          ],
        };
      } else if (msg.method === 'tools/call') {
        const params = msg.params ?? {};
        toolCalls.push({
          name: String(params['name'] ?? ''),
          arguments: params['arguments'],
          meta: params['_meta'],
        });
        result = {
          content: [{ type: 'text', text: JSON.stringify({ echoed: params['arguments'], has_meta: params['_meta'] !== undefined }) }],
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub mcp did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    toolCalls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

describe('kap-server raw substrate R1-R5 integration', () => {
  const fixture = usePromptFixture();

  async function pointStubModelAt(url: string): Promise<void> {
    const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
    await mutations.updateProvider('stub', { base_url: url });
    await mutations.updateModel('stub', { max_context_size: 100000 });
  }

  it('supports R1 wait=true, output_schema, include_thinking, and subagent inherit=false defaults for user_tools & mcp_servers', async () => {
    const mcp = await startStubHttpMcpServer();
    const llm = await startStubLlmServer((_req, index) => {
      if (index === 0) {
        return {
          reasoning: 'Checking structured schema constraints',
          content: '{"answer":42,"label":"ok"}',
        };
      }
      return { content: 'not valid json' };
    });
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const session = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          mcp_servers: {
            scoped_default: { transport: 'http', url: mcp.url },
            scoped_inherited: { transport: 'http', url: mcp.url, inherit: true },
          },
          user_tools: [
            {
              name: 'local_only_tool',
              description: 'Default non-inherited user tool',
              input_schema: { type: 'object', properties: { q: { type: 'string' } } },
            },
            {
              name: 'shared_user_tool',
              description: 'Explicitly inherited user tool',
              input_schema: { type: 'object', properties: { q: { type: 'string' } } },
              inherit: true,
            },
          ],
        });

        const schema = {
          type: 'object',
          required: ['answer', 'label'],
          properties: {
            answer: { type: 'integer' },
            label: { type: 'string' },
          },
        };

        const settled = await klient.rest!.raw.submitPrompt(session.id, {
          content: [{ type: 'text', text: 'Return structured JSON' }],
          wait: true,
          include_thinking: true,
          output_schema: schema,
        });

        expect(settled.turn_result?.status).toBe('completed');
        expect(settled.turn_result?.structured_output).toEqual({ answer: 42, label: 'ok' });
        expect(settled.turn_result?.thinking).toContain('Checking structured schema constraints');
        expect(settled.turn_result?.usage?.output_tokens).toBeGreaterThan(0);
        expect(llm.requests[0]?.response_format).toMatchObject({
          type: 'json_schema',
          json_schema: { name: 'output', strict: true, schema },
        });

        const invalidSettled = await klient.rest!.raw.submitPrompt(session.id, {
          content: [{ type: 'text', text: 'Return broken JSON' }],
          wait: true,
          output_schema: schema,
        });
        expect(invalidSettled.turn_result?.status).toBe('failed');
        expect(invalidSettled.turn_result?.error).toContain('not valid JSON');

        const liveSession = getLiveSessionById(fixture.server!.core.accessor, session.id)!;
        const mainAgent = await ensureMainAgent(liveSession);
        expect(mainAgent.accessor.get(IAgentUserToolService).list().map((t) => t.name).toSorted()).toEqual([
          'local_only_tool',
          'shared_user_tool',
        ]);

        const childAgent = await liveSession.accessor.get(IAgentLifecycleService).create({
          agentId: 'child-inherit-check',
          delegator: { kind: 'agent', agentId: 'main' },
        });
        expect(childAgent.accessor.get(IAgentUserToolService).list().map((t) => t.name)).toEqual(['shared_user_tool']);

        await mainAgent.accessor.get(IAgentMcpService).waitForInitialLoad();
        const registry = mainAgent.accessor.get(IAgentToolRegistryService);
        const defaultToolInfo = registry.list().find((t) => t.name.includes('scoped_default'));
        const inheritedToolInfo = registry.list().find((t) => t.name.includes('scoped_inherited'));
        expect(defaultToolInfo).toBeDefined();
        expect(inheritedToolInfo).toBeDefined();
        expect(registry.resolve(defaultToolInfo!.name)?.subagentDefault).toBe('opt-in');
        expect(registry.resolve(inheritedToolInfo!.name)?.subagentDefault).toBeUndefined();
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
      await mcp.close();
    }
  });

  it('supports R4(c) declarative user_tools pause/snapshot/respond and R2 session event stream + reset', async () => {
    const llm = await startStubLlmServer((req) => {
      const hasToolResult = (req.messages ?? []).some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return {
          toolCalls: [{ id: 'tc-user-1', name: 'lookup_item', arguments: '{"key":"alpha"}' }],
        };
      }
      return { content: 'resolved:alpha-value' };
    });
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const session = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          user_tools: [
            {
              name: 'lookup_item',
              description: 'Look up a key in host store',
              input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
            },
          ],
        });

        const streamController = new AbortController();
        const seenFrames: Array<Record<string, unknown>> = [];
        const requiresActionPromise = new Promise<Record<string, unknown>>((resolve) => {
          void klient.rest!.raw.streamSessionEvents(
            session.id,
            (frame) => {
              const rawFrame = frame as unknown as Record<string, unknown>;
              seenFrames.push(rawFrame);
              if (rawFrame['type'] === 'tool.requires_action') {
                resolve(rawFrame);
              }
            },
            { format: 'ndjson', signal: streamController.signal },
          ).catch(() => {});
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const waitPromise = klient.rest!.raw.submitPrompt(session.id, {
          content: [{ type: 'text', text: 'Look up alpha' }],
          wait: true,
        });

        const actionFrame = await requiresActionPromise;
        expect(actionFrame['name']).toBe('lookup_item');
        expect(actionFrame['args']).toEqual({ key: 'alpha' });
        const interactionId = String(actionFrame['interaction_id']);

        const snapRes = await fixture.call<{ pending_user_tools?: Array<{ interaction_id: string; name: string }> }>(
          'GET',
          `/api/sessions/${session.id}/snapshot`,
        );
        expect(snapRes.body.code).toBe(0);
        expect(snapRes.body.data.pending_user_tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ interaction_id: interactionId, name: 'lookup_item' }),
          ]),
        );

        const responded = await klient.rest!.raw.respondInteraction(session.id, interactionId, {
          result: 'alpha-value',
        });
        expect(responded).toMatchObject({ interaction_id: interactionId, resolved: true });

        const finalPrompt = await waitPromise;
        expect(finalPrompt.turn_result?.status).toBe('completed');
        expect(finalPrompt.turn_result?.text).toBe('resolved:alpha-value');
        streamController.abort();

        const firstFrame = seenFrames.find((f) => typeof f['epoch'] === 'string' && typeof f['seq'] === 'number');
        expect(firstFrame).toBeDefined();
        const epoch = String(firstFrame!['epoch']);
        const firstSeq = Number(firstFrame!['seq']);

        const replayController = new AbortController();
        const replayed: Array<Record<string, unknown>> = [];
        await klient.rest!.raw.streamSessionEvents(
          session.id,
          (frame) => {
            replayed.push(frame as unknown as Record<string, unknown>);
            if (replayed.length > 0) replayController.abort();
          },
          { after: `${epoch}:${firstSeq}`, format: 'sse', signal: replayController.signal },
        ).catch(() => {});
        expect(replayed.length).toBeGreaterThanOrEqual(1);
        expect(Number(replayed[0]!['seq'])).toBeGreaterThan(firstSeq);

        const resetFrames: Array<Record<string, unknown>> = [];
        await klient.rest!.raw.streamSessionEvents(
          session.id,
          (frame) => {
            resetFrames.push(frame as unknown as Record<string, unknown>);
          },
          { after: 'stale-epoch:0', format: 'ndjson' },
        );
        expect(resetFrames).toHaveLength(1);
        expect(resetFrames[0]).toMatchObject({ type: 'reset', reason: 'epoch_changed' });
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
    }
  });

  it('supports R3 sessionless /api/llm:complete (JSON, SSE/NDJSON, context_from, retainedUsage, >=8 concurrent)', async () => {
    const llm = await startStubLlmServer((req) => {
      const joined = (req.messages ?? []).map((m) => JSON.stringify(m.content)).join(' ');
      if (req.response_format !== undefined) {
        return { content: '{"summary":"from-r3","ok":true}' };
      }
      return { content: `echo:${joined.includes('prior-secret-fact') ? 'saw-context' : 'stateless'}` };
    });
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const sessionsRoot = join(fixture.home!, 'sessions');
        const beforeDirs = await readdir(sessionsRoot).catch(() => [] as string[]);

        const single = await klient.rest!.raw.llmComplete({
          model: 'stub',
          messages: [{ role: 'user', content: 'Produce JSON' }],
          output_schema: {
            type: 'object',
            required: ['summary', 'ok'],
            properties: { summary: { type: 'string' }, ok: { type: 'boolean' } },
          },
        });
        expect(single.structured_output).toEqual({ summary: 'from-r3', ok: true });
        expect(single.usage?.output_tokens).toBe(5);

        const afterDirs = await readdir(sessionsRoot).catch(() => [] as string[]);
        expect(afterDirs).toEqual(beforeDirs);

        const retained = fixture.server!.core.accessor.get(IRetainedUsageService);
        let foundLlmCompleteUsage = false;
        if (retained.readExportUsage !== undefined) {
          for await (const item of retained.readExportUsage(true)) {
            if (item.kind === 'operation' && item.session.id === 'standalone:llm_complete' && item.record.usage.output === 5) {
              foundLlmCompleteUsage = true;
              break;
            }
          }
        }
        expect(foundLlmCompleteUsage).toBe(true);

        const streamEvents: Array<Record<string, unknown>> = [];
        await klient.rest!.raw.llmCompleteStream(
          {
            model: 'stub',
            messages: [{ role: 'user', content: 'Stream me' }],
            stream: true,
          },
          (event) => {
            streamEvents.push(event as unknown as Record<string, unknown>);
          },
          { format: 'ndjson' },
        );
        expect(streamEvents.some((e) => e['type'] === 'delta')).toBe(true);
        expect(streamEvents.some((e) => e['type'] === 'completed')).toBe(true);

        const parallelResults = await Promise.all(
          Array.from({ length: 8 }, (_, idx) =>
            klient.rest!.raw.llmComplete({
              model: 'stub',
              messages: [{ role: 'user', content: `parallel-${idx}` }],
            }),
          ),
        );
        expect(parallelResults).toHaveLength(8);
        expect(parallelResults.every((item) => item.text === 'echo:stateless')).toBe(true);

        const session = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
        });
        await klient.rest!.raw.submitPrompt(session.id, {
          content: [{ type: 'text', text: 'Remember prior-secret-fact please' }],
          wait: true,
        });
        await closeSessionById(fixture.server!.core.accessor, session.id);
        expect(getLiveSessionById(fixture.server!.core.accessor, session.id)).toBeUndefined();

        const withContext = await klient.rest!.raw.llmComplete({
          model: 'stub',
          context_from: { session_id: session.id },
          messages: [{ role: 'user', content: 'Did you see context?' }],
        });
        expect(withContext.text).toBe('echo:saw-context');
        expect(getLiveSessionById(fixture.server!.core.accessor, session.id)).toBeUndefined();
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
    }
  });

  it('supports R5 HTTP MCP _meta.kiki propagation and R5 context.undo projection in R2', async () => {
    const mcp = await startStubHttpMcpServer();
    let mcpToolName = '';
    const llm = await startStubLlmServer((req) => {
      const hasToolResult = (req.messages ?? []).some((m) => m.role === 'tool');
      if (!hasToolResult) {
        const found = (req.tools ?? []).find((t) => t.function?.name.includes('echo_meta'))?.function?.name;
        mcpToolName = found ?? '';
        if (mcpToolName.length > 0) {
          return {
            toolCalls: [{ id: 'tc-mcp-1', name: mcpToolName, arguments: '{"msg":"hello"}' }],
          };
        }
      }
      return { content: 'mcp-done' };
    });
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const session = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          mcp_servers: {
            meta_probe: { transport: 'http', url: mcp.url },
          },
        });

        const settled = await klient.rest!.raw.submitPrompt(session.id, {
          content: [{ type: 'text', text: 'Call echo_meta' }],
          wait: true,
        });
        expect(settled.turn_result?.status).toBe('completed');
        expect(mcp.toolCalls).toHaveLength(1);
        expect(mcp.toolCalls[0]?.meta).toMatchObject({
          kiki: {
            session_id: session.id,
            agent_id: 'main',
            tool_call_id: 'tc-mcp-1',
          },
        });
        expect(typeof (mcp.toolCalls[0]?.meta as { kiki?: { turn_id?: unknown } })?.kiki?.turn_id).toBe('number');

        const undoController = new AbortController();
        const undoEventPromise = new Promise<Record<string, unknown>>((resolve) => {
          void klient.rest!.raw.streamSessionEvents(
            session.id,
            (frame) => {
              const rawFrame = frame as unknown as Record<string, unknown>;
              if (rawFrame['type'] === 'context.undo') {
                resolve(rawFrame);
                undoController.abort();
              }
            },
            { format: 'ndjson', signal: undoController.signal },
          ).catch(() => {});
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const undoRes = await fixture.call('POST', `/api/sessions/${session.id}:undo`, { turns: 1 });
        expect(undoRes.body.code).toBe(0);

        const undoFrame = await undoEventPromise;
        expect(undoFrame['type']).toBe('context.undo');
        expect(undoFrame['turns']).toBe(1);
        expect(Array.isArray(undoFrame['removed_turn_ids'])).toBe(true);
        expect((undoFrame['removed_turn_ids'] as number[]).length).toBeGreaterThanOrEqual(1);
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
      await mcp.close();
    }
  });

  it('filters private and ephemeral sessions from ThreadCommunication, NotificationService, and global /api/events', async () => {
    const llm = await startStubLlmServer(() => ({ content: 'done' }));
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const publicSession = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
        });
        const privateSession = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          private: true,
        });
        const ephemeralSession = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          ephemeral: true,
        });

        const threads = fixture.server!.core.accessor.get(IThreadCommunicationService);
        const visible = await threads.listThreads({
          caller: { sessionId: publicSession.id, workspaceId: publicSession.workspace_id },
        });
        const visibleIds = visible.threads.map((t) => t.ref.sessionId);
        expect(visibleIds).toContain(publicSession.id);
        expect(visibleIds).not.toContain(privateSession.id);
        expect(visibleIds).not.toContain(ephemeralSession.id);

        const globalController = new AbortController();
        const globalFrames: Array<Record<string, unknown>> = [];
        const publicEpisodeSeen = new Promise<void>((resolve) => {
          void klient.rest!.raw.streamGlobalEvents(
            (frame) => {
              const rawFrame = frame as unknown as Record<string, unknown>;
              globalFrames.push(rawFrame);
              if (rawFrame['type'] === 'event.session.episode_completed' && rawFrame['session_id'] === publicSession.id) {
                resolve();
              }
            },
            { format: 'ndjson', signal: globalController.signal },
          ).catch(() => {});
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        await klient.rest!.raw.submitPrompt(privateSession.id, {
          content: [{ type: 'text', text: 'Private work' }],
          wait: true,
        });
        await klient.rest!.raw.submitPrompt(ephemeralSession.id, {
          content: [{ type: 'text', text: 'Ephemeral work' }],
          wait: true,
        });
        await klient.rest!.raw.submitPrompt(publicSession.id, {
          content: [{ type: 'text', text: 'Public work' }],
          wait: true,
        });

        await publicEpisodeSeen;
        globalController.abort();

        const emittedSessionIds = globalFrames.map((f) => String(f['session_id'] ?? ''));
        expect(emittedSessionIds).toContain(publicSession.id);
        expect(emittedSessionIds).not.toContain(privateSession.id);
        expect(emittedSessionIds).not.toContain(ephemeralSession.id);

        const completionsRes = await fixture.call<Array<{ session_id: string }>>(
          'GET',
          '/api/notifications/completions',
        );
        expect(completionsRes.body.code).toBe(0);
        const notifiedIds = completionsRes.body.data.map((c) => c.session_id);
        expect(notifiedIds).toContain(publicSession.id);
        expect(notifiedIds).not.toContain(privateSession.id);
        expect(notifiedIds).not.toContain(ephemeralSession.id);
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
    }
  });

  it('enforces ksa_ budget ceilings and persists persistent=true ksa_ tokens and revocations across restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-ksa-persist-'));
    await mkdir(join(home, '.git'));
    const llm = await startStubLlmServer(() => ({ content: 'budget-ok' }));
    try {
      await writeConfigToml(
        home,
        PROMPT_TOML.replace('base_url = "http://127.0.0.1:9999"', `base_url = "${llm.url}"`).replace(
          'max_context_size = 1000',
          'max_context_size = 100000',
        ),
      );
      let server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      let base = `http://127.0.0.1:${server.port}`;

      const issueRes = await fetch(`${base}/api/session-access/tokens`, {
        method: 'POST',
        headers: authHeaders(server, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          scopes: ['llm'],
          client: { name: 'harness-test', version: '1.0.0' },
          budget: { max_requests: 2, max_tokens: 10000 },
          persistent: true,
        }),
      });
      const issued = (await issueRes.json()) as Envelope<{ id: string; token: string; persistent?: boolean }>;
      expect(issued.code, issued.msg).toBe(0);
      expect(issued.data.persistent).toBe(true);
      const token = issued.data.token;
      const tokenId = issued.data.id;

      const first = await fetch(`${base}/api/llm:complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'one' }] }),
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as Envelope<{ text: string }>).code).toBe(0);

      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 25));

      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      base = `http://127.0.0.1:${server.port}`;

      const second = await fetch(`${base}/api/llm:complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'two' }] }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as Envelope<{ text: string }>).code).toBe(0);

      const third = await fetch(`${base}/api/llm:complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'three' }] }),
      });
      expect(third.status).toBe(429);
      expect(((await third.json()) as Envelope<unknown>).code).toBe(42901);

      const revokeRes = await fetch(`${base}/api/session-access/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: authHeaders(server),
      });
      expect(((await revokeRes.json()) as Envelope<{ revoked: number }>).data.revoked).toBe(1);

      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 25));

      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      base = `http://127.0.0.1:${server.port}`;

      const afterRevoke = await fetch(`${base}/api/llm:complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'revoked' }] }),
      });
      expect(afterRevoke.status).toBe(401);

      await server.close();
    } finally {
      await llm.close();
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
    }
  });

  it('enforces ksa_ session isolation, R3 agent_id/as_of_seq validation, R1 wait=true retry & cold-resume user_tools, and R2 isolation + Last-Event-ID + mixed 8-caller concurrency', async () => {
    const llm = await startStubLlmServer((req) => {
      const hasToolResult = (req.messages ?? []).some((m) => m.role === 'tool');
      const allText = (req.messages ?? []).map((m) => JSON.stringify(m.content)).join(' ');
      if (!hasToolResult && allText.includes('trigger-user-tool')) {
        return {
          toolCalls: [{ id: 'tc-mix-1', name: 'host_gate', arguments: '{"step":1}' }],
        };
      }
      return { content: 'mixed-ok' };
    });
    try {
      await pointStubModelAt(llm.url);
      const klient = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
      try {
        const sessionA = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
          user_tools: [
            {
              name: 'host_gate',
              description: 'Blocks turn until host responds',
              input_schema: { type: 'object', properties: { step: { type: 'integer' } } },
            },
          ],
        });
        const sessionB = await klient.rest!.raw.createSession({
          metadata: { cwd: fixture.home! },
          agent_config: { permission_mode: 'yolo' },
        });

        const unboundIssue = await fixture.call<{ token: string }>('POST', '/api/session-access/tokens', {
          scopes: ['llm', 'read', 'prompt'],
          client: { name: 'unbound-app', version: '1.0.0' },
          persistent: true,
        });
        expect(unboundIssue.body.code).toBe(0);
        const unboundToken = unboundIssue.body.data.token;

        const wildcardRead = await fetch(`${fixture.base}/api/sessions/${sessionA.id}/snapshot`, {
          headers: { authorization: `Bearer ${unboundToken}` },
        });
        expect(wildcardRead.status).toBe(403);

        const wildcardCreate = await fetch(`${fixture.base}/api/sessions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${unboundToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ metadata: { cwd: fixture.home! } }),
        });
        expect(wildcardCreate.status).toBe(403);

        const unboundContextFrom = await fetch(`${fixture.base}/api/llm:complete`, {
          method: 'POST',
          headers: { authorization: `Bearer ${unboundToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'stub',
            context_from: { session_id: sessionA.id },
            messages: [{ role: 'user', content: 'borrow?' }],
          }),
        });
        expect(unboundContextFrom.status).toBe(403);

        const traversalRes = await fixture.call('POST', '/api/llm:complete', {
          model: 'stub',
          context_from: { session_id: sessionA.id, agent_id: '../../secret' },
          messages: [{ role: 'user', content: 'escape?' }],
        });
        expect(traversalRes.body.code).toBe(40001);

        const staleWatermark = await fixture.call('POST', '/api/llm:complete', {
          model: 'stub',
          context_from: { session_id: sessionA.id, as_of_seq: 99999 },
          messages: [{ role: 'user', content: 'stale?' }],
        });
        expect(staleWatermark.body.code).toBe(40937);

        const badCursor = await fetch(`${fixture.base}/api/sessions/${sessionA.id}/events?after=bad:notanumber`, {
          headers: authHeaders(fixture.server!),
        });
        expect(((await badCursor.json()) as Envelope<unknown>).code).toBe(40001);

        const durableAndWait = await fixture.call('POST', `/api/sessions/${sessionB.id}/prompts`, {
          content: [{ type: 'text', text: 'conflict' }],
          admission: 'durable',
          wait: true,
        });
        expect(durableAndWait.body.code).toBe(40001);

        const firstWait = await klient.rest!.raw.submitPrompt(sessionB.id, {
          prompt_id: 'idempotent-wait-1',
          content: [{ type: 'text', text: 'hello retry' }],
          wait: true,
        });
        expect(firstWait.turn_result?.status).toBe('completed');
        expect(firstWait.turn_result?.text).toBe('mixed-ok');
        expect(firstWait.turn_result?.usage).toBeDefined();

        const retryWait = await klient.rest!.raw.submitPrompt(sessionB.id, {
          prompt_id: 'idempotent-wait-1',
          content: [{ type: 'text', text: 'hello retry' }],
          wait: true,
          include_thinking: true,
        });
        expect(retryWait.prompt_id).toBe('idempotent-wait-1');
        expect(retryWait.turn_result?.status).toBe('completed');
        expect(retryWait.turn_result?.text).toBe('mixed-ok');
        expect(retryWait.turn_result?.usage).toEqual(firstWait.turn_result?.usage);

        const sessionAFrames: Array<Record<string, unknown>> = [];
        const streamAController = new AbortController();
        const actionSeen = new Promise<string>((resolve) => {
          void klient.rest!.raw.streamSessionEvents(
            sessionA.id,
            (frame) => {
              const raw = frame as unknown as Record<string, unknown>;
              sessionAFrames.push(raw);
              if (raw['type'] === 'tool.requires_action') resolve(String(raw['interaction_id']));
            },
            { format: 'ndjson', grade: 'delta', signal: streamAController.signal },
          ).catch(() => {});
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const blockedTurnPromise = klient.rest!.raw.submitPrompt(sessionA.id, {
          content: [{ type: 'text', text: 'trigger-user-tool' }],
          wait: true,
        });
        const interactionId = await actionSeen;

        const mixedResults = await Promise.all([
          klient.rest!.raw.submitPrompt(sessionB.id, {
            content: [{ type: 'text', text: 'concurrent R1 on sessionB' }],
            wait: true,
          }),
          ...Array.from({ length: 6 }, (_, idx) =>
            klient.rest!.raw.llmComplete({
              model: 'stub',
              messages: [{ role: 'user', content: `mixed-r3-${idx}` }],
            }),
          ),
        ]);
        expect((mixedResults[0] as { turn_result?: { status?: string } }).turn_result?.status).toBe('completed');
        for (let idx = 1; idx < mixedResults.length; idx += 1) {
          expect((mixedResults[idx] as { text?: string }).text).toBe('mixed-ok');
        }
        expect(sessionAFrames.every((frame) => frame['session_id'] === sessionA.id)).toBe(true);

        await klient.rest!.raw.respondInteraction(sessionA.id, interactionId, { result: 'unblocked' });
        const unblocked = await blockedTurnPromise;
        expect(unblocked.turn_result?.status).toBe('completed');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sessionAFrames.some((frame) => frame['type'] === 'assistant.delta')).toBe(true);
        streamAController.abort();

        const undoFrames: Array<Record<string, unknown>> = [];
        const undoStreamController = new AbortController();
        void klient.rest!.raw.streamSessionEvents(
          sessionB.id,
          (frame) => {
            const raw = frame as unknown as Record<string, unknown>;
            if (raw['type'] === 'context.undo') undoFrames.push(raw);
          },
          { format: 'ndjson', signal: undoStreamController.signal },
        ).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 40));
        const undo1 = await fixture.call('POST', `/api/sessions/${sessionB.id}:undo`, { turns: 1 });
        expect(undo1.body.code).toBe(0);
        const undo2 = await fixture.call('POST', `/api/sessions/${sessionB.id}:undo`, { turns: 1 });
        expect(undo2.body.code).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        undoStreamController.abort();
        expect(undoFrames.length).toBeGreaterThanOrEqual(2);
        const removed1 = (undoFrames[0]?.['removed_turn_ids'] as number[] | undefined) ?? [];
        const removed2 = (undoFrames[1]?.['removed_turn_ids'] as number[] | undefined) ?? [];
        expect(removed1.length).toBeGreaterThan(0);
        expect(removed2.length).toBeGreaterThan(0);
        expect(removed1.some((id) => removed2.includes(id))).toBe(false);

        const tightTokenRes = await fixture.call<{ id: string; token: string }>('POST', '/api/session-access/tokens', {
          scopes: ['llm'],
          client: { name: 'budget-order-test', version: '1.0.0' },
          budget: { max_requests: 1, max_tokens: 100 },
        });
        expect(tightTokenRes.body.code).toBe(0);
        const tightToken = tightTokenRes.body.data.token;
        const badSchemaRes = await fetch(`${fixture.base}/api/llm:complete`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tightToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'stub',
            messages: [{ role: 'user', content: 'hi' }],
            output_schema: { type: 'object', patternProperties: { '^a': { type: 'string' } } },
          }),
        });
        expect(((await badSchemaRes.json()) as Envelope<unknown>).code).toBe(40001);
        const oversizeRes = await fetch(`${fixture.base}/api/llm:complete`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tightToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'stub',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 500,
          }),
        });
        expect(oversizeRes.status).toBe(429);
        const validAfterReject = await fetch(`${fixture.base}/api/llm:complete`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tightToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'stub',
            messages: [{ role: 'user', content: 'ok' }],
            max_tokens: 20,
          }),
        });
        expect(validAfterReject.status).toBe(200);
        expect(((await validAfterReject.json()) as Envelope<{ text: string }>).code).toBe(0);

        await getLiveSessionById(fixture.server!.core.accessor, sessionA.id)!
          .accessor.get(ISessionMetadata)
          .update({ custom: { userNote: 'overwrite-custom' } });
        await closeSessionById(fixture.server!.core.accessor, sessionA.id);
        const afterResumePrompt = await klient.rest!.raw.submitPrompt(sessionA.id, {
          content: [{ type: 'text', text: 'check restored user_tools' }],
          wait: true,
        });
        expect(afterResumePrompt.turn_result?.status).toBe('completed');
        const resumedSession = getLiveSessionById(fixture.server!.core.accessor, sessionA.id)!;
        const resumedMain = await ensureMainAgent(resumedSession);
        expect(resumedMain.accessor.get(IAgentUserToolService).list().map((t) => t.name)).toContain('host_gate');
      } finally {
        await klient.close();
      }
    } finally {
      await llm.close();
    }
  });
});
