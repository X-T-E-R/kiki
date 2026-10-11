import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { IAgentLifecycleService, IAgentLoopService, getLiveSessionById, closeSessionById } from '@kiki/agent-core-v2';
import type { TranscriptResponse } from '@kiki/transcript';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

it('serves accepted prompt image bytes while the native model request remains held, then after completion and cold reload', async () => {
  const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
  const { picture } = await import(fixture);
  const original: Buffer = picture(80, 60, [140, 50, 20]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { entered = resolve; });
  let requestBody = '';
  const model = createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    if (body.includes('image_url')) { requestBody = body; entered(); await gate; }
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const home = await mkdtemp(join(tmpdir(), 'kiki-live-media-'));
  const cwd = join(home, 'workspace');
  await mkdir(cwd);
  await writeFile(join(home, 'config.toml'), `default_model = "fixture"\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${port}"\napi_key = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 256000\ncapabilities = ["image_in"]\n[search]\nenabled = false\n[cron]\nmanualTick = true\n`);
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: authHeaders(server, body === undefined ? {} : { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
    const envelope = await response.json() as { code: number; data: T };
    expect(envelope.code).toBe(0);
    return envelope.data;
  };
  try {
    const session = await call<{ id: string }>('/sessions', { metadata: { cwd }, agent_config: { permission_mode: 'manual' } });
    const accepted = await call<{ status: string; prompt_id: string }>(`/sessions/${session.id}/prompts`, { content: [{ type: 'text', text: 'Inspect this image.' }, { type: 'image', name: 'ordinary.png', source: { kind: 'base64', media_type: 'image/png', data: original.toString('base64') } }] });
    await held;
    expect(accepted.status).toBe('running');
    expect(requestBody).toContain(original.toString('base64'));
    const transcriptPath = `/sessions/${session.id}/transcript?agent_id=main&transcript_coverage_version=2`;
    const page = await call<TranscriptResponse>(transcriptPath);
    const prompt = page.prompts.find((item) => item.promptId === accepted.prompt_id)!;
    expect(prompt.status).toBe('running');
    const image = (prompt.content as { type: string; source: { kind: string; file_id: string } }[]).find((part) => part.type === 'image')!;
    expect(image.source.kind).toBe('session_media');
    const path = `/api/sessions/${session.id}/media/${encodeURIComponent(image.source.file_id)}`;
    const read = async () => {
      const response = await fetch(`${base}${path}`, { headers: authHeaders(server) });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/png');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
    };
    await read();
    const preview = await fetch(`${base}${path}/preview`, { headers: authHeaders(server) });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toMatch(/^image\//u);
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await call<TranscriptResponse>(transcriptPath)).prompts.find((item) => item.promptId === accepted.prompt_id)!.status).toBe('running');
    const invalidPath = `/api/sessions/${session.id}/media/${encodeURIComponent(image.source.file_id.replace(/:[0-9a-f]{64}$/u, ':' + '0'.repeat(64)))}`;
    expect((await fetch(`${base}${invalidPath}`, { headers: authHeaders(server) })).status).toBe(404);
    await read();
    release();
    const main = getLiveSessionById(server.core.accessor, session.id)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentLoopService).settled();
    await read();
    await closeSessionById(server.core.accessor, session.id);
    expect(getLiveSessionById(server.core.accessor, session.id)).toBeUndefined();
    const coldPage = await call<TranscriptResponse>(transcriptPath);
    const coldImage = (coldPage.prompts.find((item) => item.promptId === accepted.prompt_id)!.content as { type: string; source: { url: string } }[]).find((part) => part.type === 'image')!;
    const hash = /^blobref:image\/png;([0-9a-f]{64})$/u.exec(coldImage.source.url)![1]!;
    const coldResponse = await fetch(`${base}/api/sessions/${session.id}/media/${encodeURIComponent(`blobref:main:${hash}`)}`, { headers: authHeaders(server) });
    expect(coldResponse.status).toBe(200);
    expect(Buffer.from(await coldResponse.arrayBuffer())).toEqual(original);
    expect(getLiveSessionById(server.core.accessor, session.id)).toBeUndefined();
  } finally {
    release();
    await server.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}, 30_000);
