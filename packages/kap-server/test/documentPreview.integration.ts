import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  IFileService,
  ISessionMediaStore,
  getLiveSessionById,
  type Scope,
} from '@kiki/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T = unknown> {
  readonly code: number;
  readonly msg: string;
  readonly data: T | null;
  readonly request_id?: string;
}

interface PreviewAsset {
  readonly asset_id: string;
  readonly mime: string;
  readonly url: string;
}

interface PreviewReady {
  readonly kind: 'ready';
  readonly renderer: string;
  readonly format: string;
  readonly assets: readonly PreviewAsset[];
}

interface PreviewResponse {
  readonly kind: string;
  readonly renderer?: string;
  readonly format?: string;
  readonly assets?: readonly PreviewAsset[];
}

interface FileMeta {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
}

interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly rawPayload: Buffer;
  json(): unknown;
}

function enabled(): boolean {
  return ['KIKI_PREVIEW_PDF', 'KIKI_PREVIEW_DOCX', 'KIKI_PREVIEW_OFFICECLI', 'KIKI_PREVIEW_PLUGIN_ROOT']
    .every((key) => typeof process.env[key] === 'string' && process.env[key].length > 0);
}

function pluginStateProofEnabled(): boolean {
  return ['KIKI_PREVIEW_DOCX', 'KIKI_PREVIEW_OFFICECLI', 'KIKI_PREVIEW_PLUGIN_ROOT']
    .every((key) => typeof process.env[key] === 'string' && process.env[key].length > 0);
}

function appOf(server: RunningServer): { inject(req: unknown): Promise<InjectResponse> } {
  const app = server.app as unknown as { inject(req: unknown): Promise<InjectResponse> };
  return {
    inject: (request) => app.inject({
      ...(request as Record<string, unknown>),
      headers: {
        ...(request as { headers?: Record<string, string> }).headers,
        authorization: `Bearer ${server.localOwnerToken}`,
      },
    }),
  };
}

function multipart(file: { readonly name: string; readonly mime: string; readonly bytes: Buffer }): { readonly body: Buffer; readonly contentType: string } {
  const boundary = '----kiki-document-preview-real-proof';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function json<T>(response: InjectResponse): Promise<Envelope<T>> {
  return response.json() as Envelope<T>;
}

async function createSessionForProof(app: ReturnType<typeof appOf>, cwd: string): Promise<string> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { metadata: { cwd } }, headers: { 'content-type': 'application/json' } });
    const envelope = await json<{ readonly id: string }>(response);
    if (envelope.code === 0 && envelope.data !== null) return envelope.data.id;
    if (envelope.code !== 40939 || attempt === 23) throw new Error(`session creation failed: ${envelope.code} ${envelope.msg}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(2_000, 250 * (attempt + 1))); });
  }
  throw new Error('session creation retry budget exhausted');
}

describe('real document preview REST proof', () => {
  it.skipIf(process.env['KIKI_PREVIEW_PLUGIN_STATE_PROOF'] !== '1' || !pluginStateProofEnabled())('reports not-installed and disabled plugin states without auto-enabling', async () => {
    const docxPath = process.env['KIKI_PREVIEW_DOCX']!;
    const officecliPath = process.env['KIKI_PREVIEW_OFFICECLI']!;
    const pluginRoot = process.env['KIKI_PREVIEW_PLUGIN_ROOT']!;
    const home = await mkdtemp(join(tmpdir(), 'kiki-document-preview-plugin-state-'));
    let server: RunningServer | undefined;
    try {
      await copyFile(docxPath, join(home, basename(docxPath)));
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        env: { ...process.env, KIKI_SEARCH_BACKEND: 'minidb', KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' },
        logLevel: 'silent',
      });
      const app = appOf(server);
      const sessionId = await createSessionForProof(app, home);
      const preview = await app.inject({ method: 'POST', url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`, payload: { source: { kind: 'workspace', path: basename(docxPath) }, page: 1 }, headers: { 'content-type': 'application/json' } });
      const notInstalled = await json<{ readonly kind: string; readonly recovery?: { readonly plugin_state?: string } }>(preview);
      expect(notInstalled.code, notInstalled.msg).toBe(0);
      expect(notInstalled.data).toMatchObject({ kind: 'missing_dependency', recovery: { plugin_state: 'not-installed' } });

      const planResponse = await app.inject({ method: 'POST', url: '/api/plugins:preview', payload: { source: pluginRoot }, headers: { 'content-type': 'application/json' } });
      const plan = await json<{ readonly fingerprint: string }>(planResponse);
      expect(plan.code, plan.msg).toBe(0);
      expect((await json(await app.inject({ method: 'POST', url: '/api/plugins', payload: { source: pluginRoot, fingerprint: plan.data!.fingerprint, consent: true }, headers: { 'content-type': 'application/json' } }))).code).toBe(0);
      expect((await json(await app.inject({ method: 'POST', url: '/api/plugins/kiki-office:enable' }))).code).toBe(0);
      expect((await json(await app.inject({ method: 'POST', url: '/api/plugins/kiki-office/settings', payload: { values: { officecliPath } }, headers: { 'content-type': 'application/json' } }))).code).toBe(0);
      expect((await json(await app.inject({ method: 'POST', url: '/api/plugins/kiki-office:disable' }))).code).toBe(0);

      const disabledPreview = await app.inject({ method: 'POST', url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`, payload: { source: { kind: 'workspace', path: basename(docxPath) }, page: 1 }, headers: { 'content-type': 'application/json' } });
      const disabled = await json<{ readonly kind: string; readonly recovery?: { readonly plugin_state?: string } }>(disabledPreview);
      expect(disabled.code, disabled.msg).toBe(0);
      expect(disabled.data).toMatchObject({ kind: 'missing_dependency', recovery: { plugin_state: 'disabled' } });
      const info = await json<{ readonly enabled: boolean }>(await app.inject({ method: 'GET', url: '/api/plugins/kiki-office' }));
      expect(info.code, info.msg).toBe(0);
      expect(info.data?.enabled).toBe(false);
    } finally {
      await server?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it.skipIf(!enabled())('renders workspace PDF browser fallback and session-media Office PNG through authenticated REST', async () => {
    const pdfPath = process.env['KIKI_PREVIEW_PDF']!;
    const docxPath = process.env['KIKI_PREVIEW_DOCX']!;
    const officecliPath = process.env['KIKI_PREVIEW_OFFICECLI']!;
    const pluginRoot = process.env['KIKI_PREVIEW_PLUGIN_ROOT']!;
    const home = await mkdtemp(join(tmpdir(), 'kiki-document-preview-rest-'));
    let server: RunningServer | undefined;
    const oldPath = process.env['PATH'];
    const oldSearchBackend = process.env['KIKI_SEARCH_BACKEND'];
    const oldSearchWorker = process.env['KIKI_EXPERIMENTAL_SEARCH_WORKER'];
    const emptyPath = await mkdtemp(join(tmpdir(), 'kiki-document-preview-no-poppler-'));
    try {
      const pdfBytes = await readFile(pdfPath);
      const docxBytes = await readFile(docxPath);
      await copyFile(pdfPath, join(home, basename(pdfPath)));
      await copyFile(docxPath, join(home, basename(docxPath)));
      process.env['KIKI_SEARCH_BACKEND'] = 'minidb';
      process.env['KIKI_EXPERIMENTAL_SEARCH_WORKER'] = 'false';

      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        env: { ...process.env, KIKI_SEARCH_BACKEND: 'minidb', KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' },
        logLevel: 'silent',
      });
      const app = appOf(server);

      const pluginPreview = await app.inject({
        method: 'POST',
        url: '/api/plugins:preview',
        payload: { source: pluginRoot },
        headers: { 'content-type': 'application/json' },
      });
      const pluginPlan = await json<{ readonly fingerprint: string }>(pluginPreview);
      expect(pluginPlan.code, pluginPlan.msg).toBe(0);
      const pluginInstall = await app.inject({
        method: 'POST',
        url: '/api/plugins',
        payload: { source: pluginRoot, fingerprint: pluginPlan.data!.fingerprint, consent: true },
        headers: { 'content-type': 'application/json' },
      });
      expect((await json(pluginInstall)).code).toBe(0);
      const enable = await app.inject({ method: 'POST', url: '/api/plugins/kiki-office:enable' });
      expect((await json(enable)).code).toBe(0);
      const settings = await app.inject({
        method: 'POST',
        url: '/api/plugins/kiki-office/settings',
        payload: { values: { officecliPath: officecliPath } },
        headers: { 'content-type': 'application/json' },
      });
      expect((await json(settings)).code).toBe(0);

      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { metadata: { cwd: home } },
        headers: { 'content-type': 'application/json' },
      });
      const firstSession = await json<{ readonly id: string }>(created);
      expect(firstSession.code, firstSession.msg).toBe(0);
      const sessionId = firstSession.data!.id;
      const secondCreated = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { metadata: { cwd: home } },
        headers: { 'content-type': 'application/json' },
      });
      const secondSession = await json<{ readonly id: string }>(secondCreated);
      expect(secondSession.code, secondSession.msg).toBe(0);

      process.env['PATH'] = emptyPath;
      const pdfPreview = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`,
        payload: { source: { kind: 'workspace', path: basename(pdfPath) }, page: 1 },
        headers: { 'content-type': 'application/json' },
      });
      const pdfEnvelope = await json<PreviewReady>(pdfPreview);
      expect(pdfPreview.statusCode, pdfEnvelope.msg).toBe(200);
      expect(pdfEnvelope.code).toBe(0);
      expect(pdfEnvelope.data).toMatchObject({ kind: 'ready', format: 'pdf', renderer: 'browser-pdf' });
      const pdfAsset = pdfEnvelope.data!.assets[0]!;
      const pdfAssetResponse = await app.inject({ method: 'GET', url: pdfAsset.url });
      expect(pdfAssetResponse.statusCode).toBe(200);
      expect(pdfAssetResponse.headers['content-type']).toContain('application/pdf');
      expect(pdfAssetResponse.rawPayload).toEqual(pdfBytes);

      const workspaceOffice = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`,
        payload: { source: { kind: 'workspace', path: basename(docxPath) }, page: 1 },
        headers: { 'content-type': 'application/json' },
      });
      const workspaceOfficeEnvelope = await json<PreviewReady>(workspaceOffice);
      expect(workspaceOfficeEnvelope.code, workspaceOfficeEnvelope.msg).toBe(0);
      expect(workspaceOfficeEnvelope.data).toMatchObject({ kind: 'ready', format: 'docx', renderer: 'officecli' });
      const workspacePng = workspaceOfficeEnvelope.data!.assets[0]!;
      const workspacePngResponse = await app.inject({ method: 'GET', url: workspacePng.url });
      expect(workspacePngResponse.statusCode).toBe(200);
      expect(workspacePngResponse.headers['content-type']).toContain('image/png');
      expect(workspacePngResponse.rawPayload.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));

      const uploadAndMaterialize = async (name: string, mime: string, bytes: Buffer): Promise<FileMeta> => {
        const body = multipart({ name, mime, bytes });
        const uploaded = await app.inject({
          method: 'POST',
          url: '/api/files',
          payload: body.body,
          headers: { 'content-type': body.contentType },
        });
        const envelope = await json<FileMeta>(uploaded);
        expect(envelope.code, envelope.msg).toBe(0);
        const media = getLiveSessionById(server!.core.accessor, sessionId);
        expect(media).toBeDefined();
        const stored = await server!.core.accessor.get(IFileService).get(envelope.data!.id);
        await media!.accessor.get(ISessionMediaStore).materialize({
          fileId: envelope.data!.id,
          name: envelope.data!.name,
          mimeType: envelope.data!.media_type,
          size: envelope.data!.size,
          stream: () => stored.stream(),
        });
        return envelope.data!;
      };
      const pdfMedia = await uploadAndMaterialize(basename(pdfPath), 'application/pdf', pdfBytes);
      const uploadedEnvelope = await uploadAndMaterialize(
        basename(docxPath),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        docxBytes,
      );

      const mediaPdfPreview = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`,
        payload: { source: { kind: 'session-media', file_id: pdfMedia.id }, page: 1 },
        headers: { 'content-type': 'application/json' },
      });
      const mediaPdfEnvelope = await json<PreviewReady>(mediaPdfPreview);
      expect(mediaPdfEnvelope.code, mediaPdfEnvelope.msg).toBe(0);
      expect(mediaPdfEnvelope.data).toMatchObject({ kind: 'ready', format: 'pdf', renderer: 'browser-pdf' });
      const mediaPdfAsset = mediaPdfEnvelope.data!.assets[0]!;
      const mediaPdfAssetResponse = await app.inject({ method: 'GET', url: mediaPdfAsset.url });
      expect(mediaPdfAssetResponse.statusCode).toBe(200);
      expect(mediaPdfAssetResponse.headers['content-type']).toContain('application/pdf');
      expect(mediaPdfAssetResponse.rawPayload).toEqual(pdfBytes);

      const mediaPreview = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview`,
        payload: { source: { kind: 'session-media', file_id: uploadedEnvelope.id }, page: 1 },
        headers: { 'content-type': 'application/json' },
      });
      const mediaEnvelope = await json<PreviewReady>(mediaPreview);
      expect(mediaEnvelope.code, mediaEnvelope.msg).toBe(0);
      expect(mediaEnvelope.data).toMatchObject({ kind: 'ready', format: 'docx', renderer: 'officecli' });
      const mediaAsset = mediaEnvelope.data!.assets[0]!;
      const wrongSessionAsset = await app.inject({ method: 'GET', url: mediaAsset.url.replace(`/sessions/${sessionId}/`, `/sessions/${secondSession.data!.id}/`) });
      expect(wrongSessionAsset.statusCode).toBe(404);
      expect((await json(wrongSessionAsset)).code).toBe(40407);
      const mediaAssetResponse = await app.inject({ method: 'GET', url: mediaAsset.url });
      expect(mediaAssetResponse.statusCode).toBe(200);
      expect(mediaAssetResponse.rawPayload.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));

      const artifactDir = process.env['KIKI_PREVIEW_PROOF_ARTIFACT_DIR'];
      if (artifactDir !== undefined && artifactDir !== '') {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(join(artifactDir, 'pdf.browser.asset.pdf'), pdfAssetResponse.rawPayload);
        await writeFile(join(artifactDir, 'pdf.session-media.browser.asset.pdf'), mediaPdfAssetResponse.rawPayload);
        await writeFile(join(artifactDir, 'workspace.office.png'), workspacePngResponse.rawPayload);
        await writeFile(join(artifactDir, 'session-media.office.png'), mediaAssetResponse.rawPayload);
      }
      const proof = JSON.stringify({
        home,
        sessionId,
        secondSessionId: secondSession.data!.id,
        pdf: { renderer: pdfEnvelope.data!.renderer, sourceBytes: pdfBytes.byteLength, assetBytes: pdfAssetResponse.rawPayload.byteLength },
        sessionMediaPdf: { renderer: mediaPdfEnvelope.data!.renderer, assetBytes: mediaPdfAssetResponse.rawPayload.byteLength },
        workspaceOffice: { renderer: workspaceOfficeEnvelope.data!.renderer, assetBytes: workspacePngResponse.rawPayload.byteLength },
        sessionMediaOffice: { renderer: mediaEnvelope.data!.renderer, assetBytes: mediaAssetResponse.rawPayload.byteLength, wrongSessionStatus: wrongSessionAsset.statusCode },
      });
      if (process.env['KIKI_PREVIEW_PROOF_OUTPUT'] === '1') console.log(proof);
      const proofPath = process.env['KIKI_PREVIEW_PROOF_OUTPUT_PATH'];
      if (proofPath !== undefined && proofPath !== '') await writeFile(proofPath, `${proof}\n`);
    } finally {
      process.env['PATH'] = oldPath;
      if (oldSearchBackend === undefined) delete process.env['KIKI_SEARCH_BACKEND'];
      else process.env['KIKI_SEARCH_BACKEND'] = oldSearchBackend;
      if (oldSearchWorker === undefined) delete process.env['KIKI_EXPERIMENTAL_SEARCH_WORKER'];
      else process.env['KIKI_EXPERIMENTAL_SEARCH_WORKER'] = oldSearchWorker;
      await server?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(emptyPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 180_000);
});
