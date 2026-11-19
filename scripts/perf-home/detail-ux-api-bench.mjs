import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { roundMs, summarizeSamples } from './stats.mjs';

function buildMultipartBody(filePath, mimeType, sessionId) {
  const boundary = `----kikiPerfUpload${Math.random().toString(36).slice(2)}`;
  const fileBytes = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const parts = [];
  if (sessionId) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\n${sessionId}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(fileBytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
    byteLength: fileBytes.byteLength,
  };
}

export async function runDetailUxApiSuite({
  server,
  baseUrl,
  authHeaders,
  staged,
  fixtures,
  gallerySession,
  clones,
  elMonitor,
  fileToImageAttachment,
  buildSlashItems,
  filterSlashItems,
  clearServerMediaPreviewMemoryCache,
  progress,
}) {
  const manager = server.core.accessor.get(
    (await import('../../packages/agent-core-v2/src/index.ts')).ISessionManager,
  );
  const isLive = (id) => manager.get(id) !== undefined;

  async function rawFetch(method, urlPath, { headers = {}, body } = {}) {
    const t0 = performance.now();
    const init = {
      method,
      headers: { ...authHeaders, ...headers },
    };
    if (body !== undefined) init.body = body;
    const res = await fetch(`${baseUrl}${urlPath}`, init);
    const ttfbMs = roundMs(performance.now() - t0);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const totalMs = roundMs(performance.now() - t0);
    return {
      status: res.status,
      headers: res.headers,
      bytes,
      ttfbMs,
      totalMs,
    };
  }

  async function jsonCall(method, urlPath, body, allowedCodes = [0]) {
    const t0 = performance.now();
    const init = {
      method,
      headers: body === undefined ? authHeaders : { ...authHeaders, 'content-type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${urlPath}`, init);
    const json = await res.json();
    const elapsedMs = roundMs(performance.now() - t0);
    if (res.status !== 200 || !allowedCodes.includes(json.code)) {
      throw new Error(
        `${method} ${urlPath.replace(/session_[A-Za-z0-9_-]+/g, ':id')} failed: status=${res.status} code=${json.code} msg=${String(json.msg ?? '').slice(0, 120)}`,
      );
    }
    return { elapsedMs, body: json };
  }

  async function uploadMultipart(filePath, mimeType, sessionId) {
    const mp = buildMultipartBody(filePath, mimeType, sessionId);
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': mp.contentType,
      },
      body: mp.body,
    });
    const json = await res.json();
    const elapsedMs = roundMs(performance.now() - t0);
    if (res.status !== 200 || json.code !== 0) {
      throw new Error(`POST /api/files failed: status=${res.status} code=${json.code} msg=${json.msg}`);
    }
    return { elapsedMs, meta: json.data, byteLength: mp.byteLength };
  }

  const results = {
    media: {},
    attachments: {},
    sessions: {},
    siblingDetails: {},
  };

  progress('1/4 measuring image & media endpoints (canonical, 12-image burst, blobref, host preview)...');
  {
    const heroImage =
      staged.samples.canonicalLargePngs[0] ?? {
        sessionId: gallerySession.sessionId,
        fileId: gallerySession.imageFileIds[0].fileId,
        sizeBytes: gallerySession.imageFileIds[0].sizeBytes,
      };
    const previewPath = `/api/sessions/${encodeURIComponent(heroImage.sessionId)}/media/${encodeURIComponent(heroImage.fileId)}/preview`;
    const fullPath = `/api/sessions/${encodeURIComponent(heroImage.sessionId)}/media/${encodeURIComponent(heroImage.fileId)}`;

    elMonitor.resetWindow();
    const coldPreview = await rawFetch('GET', previewPath);
    const coldPreviewEld = elMonitor.snapshot();
    if (coldPreview.status !== 200) throw new Error(`cold preview failed: ${coldPreview.status}`);
    const etag = coldPreview.headers.get('etag') ?? '';

    const warmSamples = [];
    const notModSamples = [];
    for (let i = 0; i < 8; i += 1) {
      const warm = await rawFetch('GET', previewPath);
      warmSamples.push(warm.totalMs);
      if (etag) {
        const reval = await rawFetch('GET', previewPath, { headers: { 'if-none-match': etag } });
        if (reval.status !== 304) throw new Error(`expected 304, got ${reval.status}`);
        notModSamples.push(reval.totalMs);
      }
    }

    const fullSamples = [];
    for (let i = 0; i < 4; i += 1) {
      const full = await rawFetch('GET', fullPath);
      if (full.status !== 200) throw new Error(`full media read failed: ${full.status}`);
      fullSamples.push(full.totalMs);
    }

    results.media.canonicalSingleLargePng = {
      sourceKB: Math.round(heroImage.sizeBytes / 1024),
      previewBytes: coldPreview.bytes.byteLength,
      cacheControl: coldPreview.headers.get('cache-control'),
      coldPreviewMs: coldPreview.totalMs,
      coldPreviewEld,
      warmPreviewMs: summarizeSamples(warmSamples),
      notModified304Ms: summarizeSamples(notModSamples),
      fullReadMs: summarizeSamples(fullSamples),
      materializedColdSession: isLive(heroImage.sessionId),
    };

    const burstUrls = gallerySession.imageFileIds.map(
      (img) => `/api/sessions/${encodeURIComponent(gallerySession.sessionId)}/media/${encodeURIComponent(img.fileId)}/preview`,
    );
    elMonitor.resetWindow();
    const burstColdT0 = performance.now();
    const burstColdResponses = await Promise.all(burstUrls.map((u) => rawFetch('GET', u)));
    const burstColdWallMs = roundMs(performance.now() - burstColdT0);
    const burstColdEld = elMonitor.snapshot();
    if (burstColdResponses.some((r) => r.status !== 200)) {
      throw new Error('12-image burst cold preview had non-200 status');
    }

    elMonitor.resetWindow();
    const burstWarmT0 = performance.now();
    await Promise.all(burstUrls.map((u) => rawFetch('GET', u)));
    const burstWarmWallMs = roundMs(performance.now() - burstWarmT0);
    const burstWarmEld = elMonitor.snapshot();

    let burstDiskWarmWallMs = null;
    if (typeof clearServerMediaPreviewMemoryCache === 'function') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      clearServerMediaPreviewMemoryCache();
      const diskWarmT0 = performance.now();
      const diskWarmRes = await Promise.all(burstUrls.map((u) => rawFetch('GET', u)));
      if (diskWarmRes.every((r) => r.status === 200)) {
        burstDiskWarmWallMs = roundMs(performance.now() - diskWarmT0);
      }
    }

    results.media.burst12LargePngPreviews = {
      imageCount: burstUrls.length,
      totalSourceMB: roundMs(
        gallerySession.imageFileIds.reduce((sum, item) => sum + item.sizeBytes, 0) / 1048576,
      ),
      coldBurstWallMs: burstColdWallMs,
      coldPerImageMaxMs: roundMs(Math.max(...burstColdResponses.map((r) => r.totalMs))),
      coldBurstEld: burstColdEld,
      warmMemoryBurstWallMs: burstWarmWallMs,
      warmMemoryBurstEld: burstWarmEld,
      warmDiskCacheBurstWallMs: burstDiskWarmWallMs,
    };

    const blobSample = staged.samples.blobrefPngs[0];
    if (blobSample) {
      const blobBase = `/api/sessions/${encodeURIComponent(blobSample.sessionId)}/media/${encodeURIComponent(blobSample.fileId)}`;
      elMonitor.resetWindow();
      const coldBlobPrev = await rawFetch('GET', `${blobBase}/preview?media_type=${encodeURIComponent('image/png')}`);
      const coldBlobEld = elMonitor.snapshot();
      const warmBlobPrevSamples = [];
      for (let i = 0; i < 6; i += 1) {
        const w = await rawFetch('GET', `${blobBase}/preview?media_type=${encodeURIComponent('image/png')}`);
        warmBlobPrevSamples.push(w.totalMs);
      }
      const blobFull = await rawFetch('GET', blobBase);
      results.media.blobrefToolImage = {
        sourceKB: Math.round(blobSample.sizeBytes / 1024),
        coldPreviewMs: coldBlobPrev.totalMs,
        coldPreviewEld: coldBlobEld,
        warmPreviewMs: summarizeSamples(warmBlobPrevSamples),
        fullReadMs: blobFull.totalMs,
        fullContentType: blobFull.headers.get('content-type'),
        materializedColdSession: isLive(blobSample.sessionId),
      };
    }

    const hostMediaUrl = `/api/fs:content?path=${encodeURIComponent(fixtures.diagramPath)}&preview=media`;
    const hostCold = await rawFetch('GET', hostMediaUrl);
    const hostWarmSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await rawFetch('GET', hostMediaUrl);
      hostWarmSamples.push(r.totalMs);
    }
    results.media.hostFsImagePreview = {
      sourceKB: Math.round(fs.statSync(fixtures.diagramPath).size / 1024),
      coldPreviewMs: hostCold.totalMs,
      warmPreviewMs: summarizeSamples(hostWarmSamples),
    };
  }

  progress('2/4 measuring attachment encode, upload, PreviewWorkspace routes & .ogg playback...');
  {
    if (typeof globalThis.FileReader === 'undefined') {
      globalThis.FileReader = class NodeFileReader {
        readAsDataURL(blob) {
          blob.arrayBuffer().then(
            (ab) => {
              const b64 = Buffer.from(ab).toString('base64');
              this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
              this.onload?.();
            },
            (err) => {
              this.error = err;
              this.onerror?.(err);
            },
          );
        }
      };
    }
    const pngBuf = fs.readFileSync(fixtures.single5MbPngPath);
    const makeBrowserFile = (bytes, name, type) => new File([bytes], name, { type });

    const encode1xSamples = [];
    for (let i = 0; i < 5; i += 1) {
      const f = makeBrowserFile(pngBuf, 'hero-capture.png', 'image/png');
      const t0 = performance.now();
      await fileToImageAttachment(f);
      encode1xSamples.push(roundMs(performance.now() - t0));
    }

    const sixBufs = fixtures.galleryPngPaths.slice(0, 6).map((p) => fs.readFileSync(p));
    const encode6xT0 = performance.now();
    await Promise.all(
      sixBufs.map((b, idx) => fileToImageAttachment(makeBrowserFile(b, `shot-${idx}.png`, 'image/png'))),
    );
    const encode6xMs = roundMs(performance.now() - encode6xT0);

    const up1xSamples = [];
    let uploadedImgId;
    for (let i = 0; i < 4; i += 1) {
      const u = await uploadMultipart(fixtures.single5MbPngPath, 'image/png');
      uploadedImgId = u.meta.id;
      up1xSamples.push(u.elapsedMs);
    }

    const up6xT0 = performance.now();
    const up6xResults = await Promise.all(
      fixtures.galleryPngPaths.slice(0, 6).map((p) => uploadMultipart(p, 'image/png')),
    );
    const up6xParallelMs = roundMs(performance.now() - up6xT0);

    const upPdf = await uploadMultipart(fixtures.uploadPdfPath, 'application/pdf');
    const upCode = await uploadMultipart(fixtures.upload1MbCodePath, 'text/plain');

    const promptUploadSession = await jsonCall('POST', '/api/sessions', {
      metadata: { cwd: fixtures.repoCwd },
    });
    const promptSessionId = promptUploadSession.body.data.id;
    elMonitor.resetWindow();
    const send6ImgT0 = performance.now();
    await jsonCall('POST', `/api/sessions/${encodeURIComponent(promptSessionId)}/prompts`, {
      prompt_id: 'bench_prompt_6img',
      content: [
        { type: 'text', text: 'Analyze these 6 screenshots.' },
        ...up6xResults.map((u, idx) => ({
          type: 'image',
          source: { kind: 'file', file_id: u.meta.id },
          name: `shot-${idx + 1}.png`,
        })),
      ],
    });
    const send6ImgMs = roundMs(performance.now() - send6ImgT0);
    const send6ImgEld = elMonitor.snapshot();

    results.attachments.composerStageAndUpload = {
      clientEncode1x5MbMs: summarizeSamples(encode1xSamples),
      clientEncode6xScreenshotsMs: encode6xMs,
      upload1x5MbPngMs: summarizeSamples(up1xSamples),
      upload6xScreenshotsParallelMs: up6xParallelMs,
      upload1xPdfMs: upPdf.elapsedMs,
      upload1x1MbCodeMs: upCode.elapsedMs,
      submitPromptWith6ScreenshotsMs: send6ImgMs,
      submitPromptWith6ScreenshotsEld: send6ImgEld,
      sampleUploadedIdPresent: Boolean(uploadedImgId),
    };

    const fsReadColdSession = clones.coldFsReadMega;
    const wasLiveBeforeFsRead = isLive(fsReadColdSession.sessionId);
    const fsReadCold = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(fsReadColdSession.sessionId)}/fs:read`,
      { path: 'bench-preview/engine.ts', encoding: 'base64', length: 512_000 },
    );
    const materializedByFsRead = !wasLiveBeforeFsRead && isLive(fsReadColdSession.sessionId);
    const fsReadWarmSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(fsReadColdSession.sessionId)}/fs:read`,
        { path: 'bench-preview/engine.ts', encoding: 'base64', length: 512_000 },
      );
      fsReadWarmSamples.push(r.elapsedMs);
    }

    const docColdSession = clones.coldDocPreviewMega;
    const wasLiveBeforeDoc = isLive(docColdSession.sessionId);
    const docPdfCold = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(docColdSession.sessionId)}/document-preview`,
      { source: { kind: 'workspace', path: 'bench-preview/spec.pdf' }, page: 1 },
    );
    const materializedByDocPreview = !wasLiveBeforeDoc && isLive(docColdSession.sessionId);
    const docCsvWarm = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(docColdSession.sessionId)}/document-preview`,
      { source: { kind: 'workspace', path: 'bench-preview/metrics.csv' } },
    );

    const stagedPdfForGallery = await uploadMultipart(
      fixtures.uploadPdfPath,
      'application/pdf',
      gallerySession.sessionId,
    );
    const mediaDocPdf = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(gallerySession.sessionId)}/document-preview`,
      {
        source: {
          kind: 'session-media',
          file_id: stagedPdfForGallery.meta.id,
          name: 'spec.pdf',
          media_type: 'application/pdf',
        },
        page: 1,
      },
    );

    const hostTextSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await rawFetch('GET', `/api/fs:content?path=${encodeURIComponent(fixtures.engineCodePath)}`);
      if (r.status !== 200) throw new Error(`fs:content failed: ${r.status}`);
      hostTextSamples.push(r.totalMs);
    }

    const htmlOpen = await jsonCall('POST', '/api/fs:html-preview', {
      path: fixtures.demoHtmlPath,
      workspace_root: fixtures.repoCwd,
    });
    if (htmlOpen.body.data?.preview_id) {
      await fetch(`${baseUrl}/api/fs:html-preview/${encodeURIComponent(htmlOpen.body.data.preview_id)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
    }

    const voiceTarget =
      staged.samples.voiceOggs[0] ?? {
        sessionId: gallerySession.sessionId,
        fileId: gallerySession.audioFileId,
      };
    const voicePlaybackSamples = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const mint = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(voiceTarget.sessionId)}/media-playback`,
        { file_id: voiceTarget.fileId },
      );
      const playbackUrl = new URL(mint.body.data.url, baseUrl).toString();
      const rangeRes = await fetch(playbackUrl, {
        headers: { range: 'bytes=0-32767' },
      });
      await rangeRes.arrayBuffer();
      const totalVoiceMs = roundMs(performance.now() - t0);
      if (rangeRes.status !== 206 && rangeRes.status !== 200) {
        throw new Error(`voice range GET failed: ${rangeRes.status}`);
      }
      voicePlaybackSamples.push(totalVoiceMs);
      await fetch(`${baseUrl}/api/sessions/media-playback/${encodeURIComponent(mint.body.data.preview_id)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
    }

    results.attachments.previewWorkspaceAndPlayback = {
      coldMegaFsReadCodeMs: fsReadCold.elapsedMs,
      warmMegaFsReadCodeMs: summarizeSamples(fsReadWarmSamples),
      materializedByColdFsRead: materializedByFsRead,
      coldMegaDocPreviewPdfMs: docPdfCold.elapsedMs,
      coldMegaDocPreviewCsvMs: docCsvWarm.elapsedMs,
      materializedByColdDocPreview: materializedByDocPreview,
      sessionMediaDocPreviewPdfMs: mediaDocPdf.elapsedMs,
      hostFsContentCodeMs: summarizeSamples(hostTextSamples),
      htmlPreviewMintMs: htmlOpen.elapsedMs,
      voiceOggPlaybackMintPlusRangeMs: summarizeSamples(voicePlaybackSamples),
      materializedByVoicePlayback: isLive(voiceTarget.sessionId),
    };
  }

  progress('3/4 measuring cold mega session rename, pin, privacy, archive, restore & delete-archived...');
  {
    const renameTarget = clones.coldRenameMega;
    elMonitor.resetWindow();
    const renameCold = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(renameTarget.sessionId)}/profile`,
      { title: 'Renamed Mega Thread 0' },
    );
    const renameSamples = [];
    for (let i = 1; i <= 6; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(renameTarget.sessionId)}/profile`,
        { title: `Renamed Mega Thread ${i}` },
      );
      renameSamples.push(r.elapsedMs);
    }
    const renameEld = elMonitor.snapshot();

    const pinSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(renameTarget.sessionId)}/profile`,
        { metadata: { 'kiki.pinned': i % 2 === 0 } },
      );
      pinSamples.push(r.elapsedMs);
    }

    const privTarget = clones.coldPrivacyMega;
    const privSamples = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(privTarget.sessionId)}/profile`,
        { private: i % 2 === 0 },
      );
      privSamples.push(r.elapsedMs);
    }

    const liveTitleSession = await jsonCall('POST', '/api/sessions', {
      metadata: { cwd: fixtures.repoCwd },
    });
    const liveTitleId = liveTitleSession.body.data.id;
    await jsonCall('POST', `/api/sessions/${encodeURIComponent(liveTitleId)}/prompts`, {
      prompt_id: 'bench_seed_title_turn',
      content: [{ type: 'text', text: 'Explain how atomic write durability works on Windows.' }],
    });
    const titleGenSamples = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(liveTitleId)}/title/generate`,
        { force: true },
      );
      titleGenSamples.push(r.elapsedMs);
    }

    const singleArchTarget = clones.coldArchiveRestoreMega;
    const singleArchiveSamples = [];
    const restoreSamples = [];
    let materializedByRestore = false;
    for (let i = 0; i < 4; i += 1) {
      const arch = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(singleArchTarget.sessionId)}:archive`,
        { include_attached: false },
      );
      singleArchiveSamples.push(arch.elapsedMs);
      const wasLiveBeforeRestore = isLive(singleArchTarget.sessionId);
      const rest = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(singleArchTarget.sessionId)}:restore`,
        {},
      );
      if (!wasLiveBeforeRestore && isLive(singleArchTarget.sessionId)) {
        materializedByRestore = true;
        await manager.close(singleArchTarget.sessionId);
      }
      restoreSamples.push(rest.elapsedMs);
    }

    elMonitor.resetWindow();
    const famCold = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(clones.familyRoot.sessionId)}:archive`,
      { include_attached: true },
    );
    const famColdEld = elMonitor.snapshot();

    await jsonCall('POST', '/api/sessions:restore', {
      ids: [clones.familyRoot.sessionId, ...clones.familyChildren.map((c) => c.sessionId)],
    });

    const famWarmSamples = [];
    for (let i = 0; i < 4; i += 1) {
      const fam = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(clones.familyRoot.sessionId)}:archive`,
        { include_attached: true },
      );
      famWarmSamples.push(fam.elapsedMs);
      if (i < 3) {
        await jsonCall('POST', '/api/sessions:restore', {
          ids: [clones.familyRoot.sessionId, ...clones.familyChildren.map((c) => c.sessionId)],
        });
      }
    }

    const deleteFamilyRes = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(clones.familyRoot.sessionId)}:delete-archived`,
      {},
    );

    const v2BatchIds = clones.batchSessions.map((s) => s.sessionId);
    const batchArchive = await jsonCall('POST', '/api/sessions:archive', { ids: v2BatchIds });
    const batchRestore = await jsonCall('POST', '/api/sessions:restore', { ids: v2BatchIds });

    results.sessions = {
      megaStateKB: Math.round(renameTarget.stateBytes / 1024),
      megaAgents: renameTarget.agentCount,
      coldMegaRenameFirstMs: renameCold.elapsedMs,
      coldMegaRenameWarmMs: summarizeSamples(renameSamples),
      coldMegaRenameEld: renameEld,
      coldMegaPinToggleMs: summarizeSamples(pinSamples),
      coldMegaPrivateToggleMs: summarizeSamples(privSamples),
      liveTitleGenerateMs: summarizeSamples(titleGenSamples),
      coldMegaArchiveSingleMs: summarizeSamples(singleArchiveSamples),
      coldMegaRestoreMs: summarizeSamples(restoreSamples),
      materializedByColdRestore: materializedByRestore,
      familyArchiveFirstMs: famCold.elapsedMs,
      familyArchiveFirstEld: famColdEld,
      familyArchiveWarmMs: summarizeSamples(famWarmSamples),
      deleteArchivedFamilyMs: deleteFamilyRes.elapsedMs,
      v2BatchArchive5Ms: batchArchive.elapsedMs,
      v2BatchRestore5Ms: batchRestore.elapsedMs,
    };
  }

  progress('4/4 measuring persona settings, cold model switch, @ file mention & / slash skills...');
  {
    const personaSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall(
        'GET',
        `/api/sessions/${encodeURIComponent(clones.coldRenameMega.sessionId)}/persona-settings`,
      );
      personaSamples.push(r.elapsedMs);
    }

    const modelSwitchColdTarget = clones.coldModelSwitchMega;
    const wasLiveBeforeModelSwitch = isLive(modelSwitchColdTarget.sessionId);
    const coldModelSwitch = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(modelSwitchColdTarget.sessionId)}/profile`,
      { agent_config: { model: 'mock-fast', thinking: 'medium' } },
    );
    const materializedByColdModelSwitch = !wasLiveBeforeModelSwitch && isLive(modelSwitchColdTarget.sessionId);

    const liveModelSwitchSamples = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(modelSwitchColdTarget.sessionId)}/profile`,
        { agent_config: { thinking: i % 2 === 0 ? 'high' : 'low' } },
      );
      liveModelSwitchSamples.push(r.elapsedMs);
    }

    const atMentionTarget = clones.coldAtMentionMega;
    const wasLiveBeforeAtMention = isLive(atMentionTarget.sessionId);
    const coldSessionFsSearchFirst = await jsonCall(
      'POST',
      `/api/sessions/${encodeURIComponent(atMentionTarget.sessionId)}/fs:search`,
      { query: 'feature_04', limit: 30 },
    );
    const materializedByColdAtMention = !wasLiveBeforeAtMention && isLive(atMentionTarget.sessionId);
    const sessionFsSearchWarmSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall(
        'POST',
        `/api/sessions/${encodeURIComponent(atMentionTarget.sessionId)}/fs:search`,
        { query: `feature_0${i + 1}`, limit: 30 },
      );
      sessionFsSearchWarmSamples.push(r.elapsedMs);
    }

    const wsSearchFirst = await jsonCall('POST', '/api/workspace/fs:search', {
      workspace: staged.sampleWorkspaceId,
      query: 'renderView',
      limit: 30,
    });
    const wsSuggestSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall('POST', '/api/workspace/fs:suggest', {
        workspace: staged.sampleWorkspaceId,
        query: 'packages/pkg-01/src/f',
        limit: 20,
      });
      wsSuggestSamples.push(r.elapsedMs);
    }

    const skillsTarget = clones.coldSkillsMega;
    const wasLiveBeforeSkills = isLive(skillsTarget.sessionId);
    const coldSkillsRes = await jsonCall(
      'GET',
      `/api/sessions/${encodeURIComponent(skillsTarget.sessionId)}/skills`,
    );
    const materializedByColdSkills = !wasLiveBeforeSkills && isLive(skillsTarget.sessionId);
    const warmSkillsSamples = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonCall(
        'GET',
        `/api/sessions/${encodeURIComponent(skillsTarget.sessionId)}/skills`,
      );
      warmSkillsSamples.push(r.elapsedMs);
    }

    const rawSkills = coldSkillsRes.body.data.skills ?? [];
    const slashFilterSamples = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const items = buildSlashItems(rawSkills, { hasSession: true });
      filterSlashItems(items, 'com');
      slashFilterSamples.push(roundMs(performance.now() - t0));
    }

    results.siblingDetails = {
      coldMegaPersonaSettingsMs: summarizeSamples(personaSamples),
      coldMegaModelSwitchFirstMs: coldModelSwitch.elapsedMs,
      materializedByColdModelSwitch,
      liveModelThinkingSwitchMs: summarizeSamples(liveModelSwitchSamples),
      coldMegaSessionAtMentionFirstMs: coldSessionFsSearchFirst.elapsedMs,
      coldMegaSessionAtMentionWarmMs: summarizeSamples(sessionFsSearchWarmSamples),
      materializedByColdAtMention,
      workspaceFsSearchMs: wsSearchFirst.elapsedMs,
      workspaceFsSuggestMs: summarizeSamples(wsSuggestSamples),
      coldMegaSkillsFirstMs: coldSkillsRes.elapsedMs,
      coldMegaSkillsWarmMs: summarizeSamples(warmSkillsSamples),
      materializedByColdSkills,
      skillCount: rawSkills.length,
      clientSlashBuildAndFilterMs: summarizeSamples(slashFilterSamples),
    };
  }

  return results;
}
