import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createNbSearchRuntime } from '@nb-corp/nb-search';
import { launchNbSearchWorker } from '../src/nb-search-worker';

it('runs fetch and search async snapshots through the hosted child launcher', async () => {
  const base = resolve('../../.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'nb-hosted-jobs-'));
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ answer: 'HOSTED_SEARCH_MARKER', results: [] }) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error();
    const canonical = join(root, 'config.json'); await writeFile(canonical, '{}');
    const env = { NB_SEARCH_CONFIG: canonical, NB_SEARCH_HOME: root, NB_SEARCH_GROK_API_KEY: 'fixture-key', NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
    const entry = join(root, 'worker.mjs');
    const moduleUrl = process.env['NB_SEARCH_TEST_WORKER_ENTRY'] === undefined ? import.meta.resolve('@nb-corp/nb-search') : pathToFileURL(process.env['NB_SEARCH_TEST_WORKER_ENTRY']).href;
    await writeFile(entry, `import { runWorker } from ${JSON.stringify(moduleUrl)}; await runWorker(process.argv[3], process.env, process.argv[4], () => process.send('nb-search-worker-ready-v1', () => process.disconnect()));`);
    const launcher = { launch: (id: string, jobs: string) => launchNbSearchWorker({ executable: process.execPath, entryArgs: ['--experimental-transform-types', entry] }, env, id, jobs) };
    const options = { env, config: { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0 } }, launcher };
    const runtime = createNbSearchRuntime(options);
    for (const kind of ['fetch', 'search'] as const) {
      const queued = kind === 'fetch'
        ? await runtime.fetch({ action: 'run', source: { kind: 'inline_text', content: 'HOSTED_FETCH_MARKER', media_type: 'text/plain' }, pipeline: 'direct.local', execution: 'async', idempotency_key: 'fetch' })
        : await runtime.search({ action: 'run', query: 'fixture', lane: 'gma.research', execution: 'async', idempotency_key: 'search' });
      if (queued.action !== 'run' || queued.execution !== 'async' || queued.job === undefined) throw new Error(JSON.stringify(queued));
      const id = queued.job.job_id;
      let done = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const status = await runtime[kind]({ action: 'get', job_id: id });
        if (status.action === 'get' && !['queued', 'running'].includes(status.state)) { expect(status.state, JSON.stringify(status)).toBe('succeeded'); done = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(done).toBe(true);
      const result = await runtime[kind]({ action: 'read', job_id: id });
      if (result.action !== 'read') throw new Error(JSON.stringify(result));
      expect(Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8')).toContain(kind === 'fetch' ? 'HOSTED_FETCH_MARKER' : 'HOSTED_SEARCH_MARKER');
    }
    const broken = createNbSearchRuntime({ ...options, launcher: { launch: async () => { throw new Error('fixture worker boot error'); } } } as Parameters<typeof createNbSearchRuntime>[0]);
    expect(await broken.fetch({ action: 'run', source: { kind: 'inline_text', content: 'fixture', media_type: 'text/plain' }, execution: 'async', idempotency_key: 'broken' })).toMatchObject({ status: 'failed', error: { code: 'WORKER_START_FAILED' } });
  } finally { await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
