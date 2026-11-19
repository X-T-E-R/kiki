import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function buildDeterministicPngBytes(width = 2200, height = 1400, seed = 1) {
  const rowStride = width * 4 + 1;
  const raw = Buffer.alloc(rowStride * height);
  let state = (seed * 2654435761) >>> 0 || 0x12345678;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const off = rowStart + 1 + x * 4;
      raw[off] = (state + x) & 0xff;
      raw[off + 1] = ((state >>> 8) + y) & 0xff;
      raw[off + 2] = ((state >>> 16) ^ (x + y)) & 0xff;
      raw[off + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildBenchPdfBytes(pageCount = 4) {
  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (let p = 1; p <= pageCount; p += 1) {
    const lines = [
      'BT',
      '/F1 18 Tf',
      '48 740 Td',
      `(Benchmark Specification Page ${p} of ${pageCount}) Tj`,
      '/F1 11 Tf',
      '0 -28 Td',
      `(Deterministic offline PDF fixture for PreviewWorkspace timing verification.) Tj`,
      'ET',
    ].join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(lines, 'ascii')} >>\nstream\n${lines}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export function buildSilentWavBytes(durationMs = 600, sampleRate = 16000) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export function prepareDetailWorkspaceFixtures({ staged, scratchDir, extraRepoRoots = [] }) {
  const repoCwd = staged.defaultRepoCwd;
  const previewDir = path.join(repoCwd, 'bench-preview');
  const uploadPayloadsDir = path.join(scratchDir, 'upload-payloads');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(uploadPayloadsDir, { recursive: true });

  const realPngCandidates = staged.samples.canonicalLargePngs.filter(
    (item) => item.mediaType === 'image/png' && item.sizeBytes >= 1.5 * 1048576,
  );

  const galleryPngPaths = [];
  for (let i = 0; i < 12; i += 1) {
    const dst = path.join(uploadPayloadsDir, `shot-${String(i + 1).padStart(2, '0')}.png`);
    const candidate = realPngCandidates[i];
    if (candidate && fs.existsSync(candidate.srcPath)) {
      fs.copyFileSync(candidate.srcPath, dst);
    } else {
      fs.writeFileSync(dst, buildDeterministicPngBytes(2048, 1280, i + 1));
    }
    galleryPngPaths.push(dst);
  }

  const single5MbPngPath = path.join(uploadPayloadsDir, 'hero-capture-5mb.png');
  const heroCandidate = realPngCandidates.find(
    (c) => c.sizeBytes >= 3 * 1048576 && c.sizeBytes <= 8 * 1048576 && fs.existsSync(c.srcPath),
  );
  if (heroCandidate) {
    fs.copyFileSync(heroCandidate.srcPath, single5MbPngPath);
  } else {
    fs.writeFileSync(single5MbPngPath, buildDeterministicPngBytes(1600, 1000, 99));
  }

  const sixScreenshotPaths = [];
  const mediumCandidates = staged.samples.canonicalLargePngs.filter(
    (item) =>
      item.mediaType === 'image/png' &&
      item.sizeBytes >= 1.2 * 1048576 &&
      item.sizeBytes <= 3.0 * 1048576 &&
      fs.existsSync(item.srcPath),
  );
  for (let i = 0; i < 6; i += 1) {
    const dst = path.join(uploadPayloadsDir, `attach6-${String(i + 1).padStart(2, '0')}.png`);
    if (mediumCandidates[i]) {
      fs.copyFileSync(mediumCandidates[i].srcPath, dst);
    } else {
      fs.writeFileSync(dst, buildDeterministicPngBytes(1280, 800, 200 + i));
    }
    sixScreenshotPaths.push(dst);
  }

  const diagramPath = path.join(previewDir, 'diagram.png');
  fs.copyFileSync(single5MbPngPath, diagramPath);

  const pdfBytes = buildBenchPdfBytes(5);
  const specPdfPath = path.join(previewDir, 'spec.pdf');
  const uploadPdfPath = path.join(uploadPayloadsDir, 'spec.pdf');
  fs.writeFileSync(specPdfPath, pdfBytes);
  fs.writeFileSync(uploadPdfPath, pdfBytes);

  const codeLines = [];
  for (let i = 0; i < 1600; i += 1) {
    codeLines.push(`export function computeMetric${i}(input: number): number { return input * ${i + 1} + 42; }`);
  }
  const engineCodePath = path.join(previewDir, 'engine.ts');
  fs.writeFileSync(engineCodePath, `${codeLines.join('\n')}\n`, 'utf8');

  const largeCodeLines = [];
  for (let i = 0; i < 14000; i += 1) {
    largeCodeLines.push(`export const ROW_${i} = { index: ${i}, label: "bench-item-${i}", weight: ${(i % 97) * 1.25} };`);
  }
  const upload1MbCodePath = path.join(uploadPayloadsDir, 'dataset-bundle.ts');
  fs.writeFileSync(upload1MbCodePath, `${largeCodeLines.join('\n')}\n`, 'utf8');

  const mdContent = [
    '# System Architecture Notes',
    '',
    'Overview of the subsystem pipeline and rendered local diagram:',
    '',
    '![Architecture Diagram](./diagram.png)',
    '',
    ...Array.from({ length: 120 }, (_, idx) => `## Section ${idx + 1}\n\nVerified invariant ${idx + 1} holds across cold and live scopes.\n`),
  ].join('\n');
  const archMdPath = path.join(previewDir, 'architecture.md');
  fs.writeFileSync(archMdPath, mdContent, 'utf8');

  const csvRows = ['id,category,latency_ms,status'];
  for (let i = 0; i < 500; i += 1) {
    csvRows.push(`${i + 1},surface_${i % 8},${(i % 40) + 5},ok`);
  }
  const metricsCsvPath = path.join(previewDir, 'metrics.csv');
  fs.writeFileSync(metricsCsvPath, `${csvRows.join('\n')}\n`, 'utf8');

  const demoHtmlPath = path.join(previewDir, 'demo.html');
  fs.writeFileSync(
    demoHtmlPath,
    '<!doctype html><html><head><meta charset="utf-8"><title>Bench Demo</title></head><body><main id="ready">Interactive HTML Preview Ready</main></body></html>\n',
    'utf8',
  );

  const realOgg = staged.samples.voiceOggs[0];
  let voiceAudioPath;
  let voiceMime;
  if (realOgg && fs.existsSync(realOgg.srcPath)) {
    voiceAudioPath = path.join(previewDir, 'voice.ogg');
    fs.copyFileSync(realOgg.srcPath, voiceAudioPath);
    voiceMime = 'audio/ogg';
  } else {
    voiceAudioPath = path.join(previewDir, 'voice.wav');
    fs.writeFileSync(voiceAudioPath, buildSilentWavBytes(800));
    voiceMime = 'audio/wav';
  }

  for (const extraRoot of extraRepoRoots) {
    if (!extraRoot || extraRoot === repoCwd) continue;
    const dstPreview = path.join(extraRoot, 'bench-preview');
    fs.mkdirSync(dstPreview, { recursive: true });
    for (const f of fs.readdirSync(previewDir)) {
      fs.copyFileSync(path.join(previewDir, f), path.join(dstPreview, f));
    }
    for (let pkg = 0; pkg < 6; pkg += 1) {
      const subDir = path.join(extraRoot, 'packages', `pkg-${String(pkg).padStart(2, '0')}`, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      for (let mod = 0; mod < 120; mod += 1) {
        const fileName = `feature_${String(mod).padStart(3, '0')}.ts`;
        const filePath = path.join(subDir, fileName);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, `export const feature_${pkg}_${mod} = ${mod};\n`, 'utf8');
        }
      }
    }
  }

  return {
    repoCwd,
    previewDir,
    uploadPayloadsDir,
    galleryPngPaths,
    sixScreenshotPaths,
    single5MbPngPath,
    diagramPath,
    specPdfPath,
    uploadPdfPath,
    engineCodePath,
    upload1MbCodePath,
    archMdPath,
    metricsCsvPath,
    demoHtmlPath,
    voiceAudioPath,
    voiceMime,
  };
}

export async function seedCanonicalGallerySessionViaApi({
  baseUrl,
  authHeaders,
  mockSse,
  manager,
  fixtures,
}) {
  async function uploadOne(filePath, mimeType) {
    const boundary = `----kikiSeedGallery${Math.random().toString(36).slice(2)}`;
    const fileBytes = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const res = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat([head, fileBytes, tail]),
    });
    const json = await res.json();
    if (res.status !== 200 || json.code !== 0) {
      throw new Error(`seed upload failed: ${res.status} ${json.code} ${json.msg}`);
    }
    return {
      fileId: json.data.id,
      sizeBytes: fileBytes.byteLength,
      name: filename,
    };
  }

  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Bench Visual Gallery Session',
      metadata: { cwd: fixtures.repoCwd },
    }),
  });
  const created = await createRes.json();
  if (createRes.status !== 200 || created.code !== 0) {
    throw new Error(`seed gallery session create failed: ${createRes.status} ${created.code}`);
  }
  const sessionId = created.data.id;

  const imageFileIds = await Promise.all(
    fixtures.galleryPngPaths.map((p) => uploadOne(p, 'image/png')),
  );
  const uploadedPdf = await uploadOne(fixtures.specPdfPath, 'application/pdf');
  const uploadedAudio = await uploadOne(fixtures.voiceAudioPath, fixtures.voiceMime);

  const audioExt = path.extname(fixtures.voiceAudioPath);
  const assistantMarkdown = [
    'Reviewed all 12 captures and workspace artifacts:',
    '',
    `- Code module: [engine.ts](${fixtures.engineCodePath.replaceAll('\\', '/')})`,
    `- Architecture doc: [architecture.md](${fixtures.archMdPath.replaceAll('\\', '/')})`,
    `- Specification PDF: [spec.pdf](${fixtures.specPdfPath.replaceAll('\\', '/')})`,
    `- Interactive HTML: [demo.html](${fixtures.demoHtmlPath.replaceAll('\\', '/')})`,
    `- Voice recording: [voice${audioExt}](${fixtures.voiceAudioPath.replaceAll('\\', '/')})`,
  ].join('\n');

  mockSse.setNextReplyText(assistantMarkdown);

  const promptRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt_id: 'bench_gallery_seed_turn',
      content: [
        { type: 'text', text: 'Inspect these 12 captured frames and attached specification.' },
        ...imageFileIds.map((img) => ({
          type: 'image',
          source: { kind: 'file', file_id: img.fileId },
          name: img.name,
        })),
        {
          type: 'file',
          file_id: uploadedPdf.fileId,
          name: 'spec.pdf',
          media_type: 'application/pdf',
          size: uploadedPdf.sizeBytes,
        },
        {
          type: 'audio',
          source: { kind: 'file', file_id: uploadedAudio.fileId },
          name: uploadedAudio.name,
        },
      ],
    }),
  });
  const promptJson = await promptRes.json();
  if (promptRes.status !== 200 || promptJson.code !== 0) {
    throw new Error(`seed gallery prompt failed: ${promptRes.status} ${promptJson.code} ${promptJson.msg}`);
  }

  for (let wait = 0; wait < 100; wait += 1) {
    const statusRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: authHeaders,
    });
    const statusJson = await statusRes.json();
    if (statusJson.data && !statusJson.data.busy) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const msgRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: authHeaders,
  });
  const msgJson = await msgRes.json();
  const canonicalImageIds = [];
  for (const msg of msgJson.data?.items ?? []) {
    for (const part of msg.content ?? []) {
      if (part.type === 'image') {
        const fid =
          part.source?.file_id ??
          (typeof part.source?.url === 'string' && part.source.url.startsWith('kimi-file://')
            ? part.source.url.slice('kimi-file://'.length)
            : undefined);
        if (fid) {
          canonicalImageIds.push({
            fileId: fid,
            sizeBytes: imageFileIds[canonicalImageIds.length]?.sizeBytes ?? 0,
            name: part.name ?? `shot-${canonicalImageIds.length + 1}.png`,
          });
        }
      }
    }
  }

  await manager.close(sessionId);

  return {
    sessionId,
    imageFileIds: canonicalImageIds.length === 12 ? canonicalImageIds : imageFileIds,
    pdfFileId: uploadedPdf.fileId,
    audioFileId: uploadedAudio.fileId,
  };
}
