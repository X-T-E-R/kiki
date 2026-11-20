import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function crc32Png(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i += 1) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32Png(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function oggPage({ headerType, granulePosition, serial, pageSeq, segments }) {
  const lace = [];
  let bodyLen = 0;
  for (const seg of segments) {
    bodyLen += seg.length;
    let rem = seg.length;
    while (rem >= 255) {
      lace.push(255);
      rem -= 255;
    }
    lace.push(rem);
  }
  const page = Buffer.alloc(27 + lace.length + bodyLen);
  page.write('OggS', 0, 4, 'ascii');
  page[4] = 0;
  page[5] = headerType;
  page.writeBigInt64LE(BigInt(granulePosition), 6);
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(pageSeq >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = lace.length;
  for (let i = 0; i < lace.length; i += 1) page[27 + i] = lace[i];
  let off = 27 + lace.length;
  for (const seg of segments) {
    seg.copy(page, off);
    off += seg.length;
  }
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/**
 * Generates a genuinely browser-decodable multi-second Ogg/Opus file with
 * multiple Ogg pages so Chromium <audio> reaches readyState >= 3, advances
 * currentTime, and performs real Range seeks across pages.
 */
export function buildDecodableOggOpus({ durationSec = 4.0, serial = 0x51a70001 } = {}) {
  const sampleRate = 48_000;
  const frameSamples = 960;
  const totalFrames = Math.max(50, Math.round((durationSec * sampleRate) / frameSamples));
  const preSkip = 312;

  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 8, 'ascii');
  opusHead[8] = 1;
  opusHead[9] = 1;
  opusHead.writeUInt16LE(preSkip, 10);
  opusHead.writeUInt32LE(sampleRate, 12);
  opusHead.writeInt16LE(0, 16);
  opusHead[18] = 0;

  const vendor = Buffer.from('kiki-chaos-media', 'utf8');
  const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4);
  opusTags.write('OpusTags', 0, 8, 'ascii');
  opusTags.writeUInt32LE(vendor.length, 8);
  vendor.copy(opusTags, 12);
  opusTags.writeUInt32LE(0, 12 + vendor.length);

  // Valid CELT-only 20ms mono silent Opus packet (TOC 0xf8 + 2 zero bytes)
  const opusFrame = Buffer.from([0xf8, 0xff, 0xfe]);
  const framesPerPage = 25;
  const pages = [
    oggPage({ headerType: 0x02, granulePosition: 0, serial, pageSeq: 0, segments: [opusHead] }),
    oggPage({ headerType: 0x00, granulePosition: 0, serial, pageSeq: 1, segments: [opusTags] }),
  ];

  let pageSeq = 2;
  let granule = preSkip;
  for (let i = 0; i < totalFrames; i += framesPerPage) {
    const count = Math.min(framesPerPage, totalFrames - i);
    const isLast = i + count >= totalFrames;
    granule += count * frameSamples;
    const segments = Array.from({ length: count }, () => opusFrame);
    pages.push(
      oggPage({
        headerType: isLast ? 0x04 : 0x00,
        granulePosition: granule,
        serial,
        pageSeq,
        segments,
      }),
    );
    pageSeq += 1;
  }

  return Buffer.concat(pages);
}

/**
 * Generates a genuinely browser-decodable PCM WAV (16-bit mono 24 kHz sine wave).
 */
export function buildDecodableWav({ durationSec = 4.0, sampleRate = 24_000, freqHz = 440 } = {}) {
  const numSamples = Math.max(sampleRate, Math.round(durationSec * sampleRate));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 8000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function isoBox(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'ascii');
  body.copy(out, 8);
  return out;
}

function fullBox(type, version, flags, ...payloads) {
  const hdr = Buffer.alloc(4);
  hdr[0] = version & 0xff;
  hdr[1] = (flags >>> 16) & 0xff;
  hdr[2] = (flags >>> 8) & 0xff;
  hdr[3] = flags & 0xff;
  return isoBox(type, hdr, ...payloads);
}

/**
 * Pure-Node minimal valid ISO BMFF MP4 with real ftyp + moov (mvhd + audio trak
 * carrying valid AAC-LC silent frames in mp4a/esds) + mdat so Chromium decodes,
 * reports duration > 0, plays, and seeks cleanly even without ffmpeg installed.
 */
export function buildPureNodeDecodableMp4({ durationSec = 4.0 } = {}) {
  const sampleRate = 44_100;
  const frameSamples = 1024;
  const frameCount = Math.max(44, Math.round((durationSec * sampleRate) / frameSamples));
  const totalDuration = frameCount * frameSamples;
  // Valid minimal AAC-LC mono silent raw data block (6 bytes)
  const aacSilentFrame = Buffer.from([0x01, 0x40, 0x20, 0x06, 0x4f, 0x00]);
  const mdatPayload = Buffer.concat(Array.from({ length: frameCount }, () => aacSilentFrame));

  const ftyp = isoBox(
    'ftyp',
    Buffer.from('isom', 'ascii'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2mp41', 'ascii'),
  );

  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(sampleRate, 8);
  mvhdBody.writeUInt32BE(totalDuration, 12);
  mvhdBody.writeUInt32BE(0x00010000, 16);
  mvhdBody.writeUInt16BE(0x0100, 20);
  mvhdBody.writeUInt32BE(0x00010000, 32);
  mvhdBody.writeUInt32BE(0x00010000, 48);
  mvhdBody.writeUInt32BE(0x40000000, 64);
  mvhdBody.writeUInt32BE(2, 92);
  const mvhd = fullBox('mvhd', 0, 0, mvhdBody);

  const tkhdBody = Buffer.alloc(80);
  tkhdBody.writeUInt32BE(1, 8);
  tkhdBody.writeUInt32BE(totalDuration, 16);
  tkhdBody.writeUInt16BE(0x0100, 32);
  tkhdBody.writeUInt32BE(0x00010000, 36);
  tkhdBody.writeUInt32BE(0x00010000, 52);
  tkhdBody.writeUInt32BE(0x40000000, 68);
  const tkhd = fullBox('tkhd', 0, 3, tkhdBody);

  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(sampleRate, 8);
  mdhdBody.writeUInt32BE(totalDuration, 12);
  mdhdBody.writeUInt16BE(0x55c4, 16);
  const mdhd = fullBox('mdhd', 0, 0, mdhdBody);

  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    Buffer.alloc(4),
    Buffer.from('soun', 'ascii'),
    Buffer.alloc(12),
    Buffer.from('SoundHandler\0', 'ascii'),
  );

  const smhd = fullBox('smhd', 0, 0, Buffer.alloc(4));
  const urlBox = fullBox('url ', 0, 1);
  const dref = fullBox('dref', 0, 0, Buffer.from([0, 0, 0, 1]), urlBox);
  const dinf = isoBox('dinf', dref);

  // AudioSpecificConfig: AAC-LC (2), 44100 Hz (4), mono (1) => 0x12 0x08
  const esdsPayload = Buffer.from([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfa, 0x00, 0x00, 0x00, 0xfa, 0x00,
    0x05, 0x02, 0x12, 0x08,
    0x06, 0x01, 0x02,
  ]);
  const esds = fullBox('esds', 0, 0, esdsPayload);
  const mp4aHdr = Buffer.alloc(28);
  mp4aHdr.writeUInt16BE(1, 6);
  mp4aHdr.writeUInt16BE(1, 16);
  mp4aHdr.writeUInt16BE(16, 18);
  mp4aHdr.writeUInt32BE((sampleRate << 16) >>> 0, 24);
  const mp4a = isoBox('mp4a', mp4aHdr, esds);
  const stsd = fullBox('stsd', 0, 0, Buffer.from([0, 0, 0, 1]), mp4a);

  const sttsBody = Buffer.alloc(12);
  sttsBody.writeUInt32BE(1, 0);
  sttsBody.writeUInt32BE(frameCount, 4);
  sttsBody.writeUInt32BE(frameSamples, 8);
  const stts = fullBox('stts', 0, 0, sttsBody);

  const stscBody = Buffer.alloc(16);
  stscBody.writeUInt32BE(1, 0);
  stscBody.writeUInt32BE(1, 4);
  stscBody.writeUInt32BE(frameCount, 8);
  stscBody.writeUInt32BE(1, 12);
  const stsc = fullBox('stsc', 0, 0, stscBody);

  const stszBody = Buffer.alloc(8);
  stszBody.writeUInt32BE(aacSilentFrame.length, 0);
  stszBody.writeUInt32BE(frameCount, 4);
  const stsz = fullBox('stsz', 0, 0, stszBody);

  const makeMoov = (mdatDataOffset) => {
    const stcoBody = Buffer.alloc(8);
    stcoBody.writeUInt32BE(1, 0);
    stcoBody.writeUInt32BE(mdatDataOffset, 4);
    const stco = fullBox('stco', 0, 0, stcoBody);
    const stbl = isoBox('stbl', stsd, stts, stsc, stsz, stco);
    const minf = isoBox('minf', smhd, dinf, stbl);
    const mdia = isoBox('mdia', mdhd, hdlr, minf);
    const trak = isoBox('trak', tkhd, mdia);
    return isoBox('moov', mvhd, trak);
  };

  const probeMoov = makeMoov(0);
  const mdatDataOffset = ftyp.length + probeMoov.length + 8;
  const moov = makeMoov(mdatDataOffset);
  const mdat = isoBox('mdat', mdatPayload);
  return Buffer.concat([ftyp, moov, mdat]);
}

let cachedFfmpegAvailable;
export function hasFfmpeg() {
  if (cachedFfmpegAvailable !== undefined) return cachedFfmpegAvailable;
  const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5_000 });
  cachedFfmpegAvailable = res.status === 0;
  return cachedFfmpegAvailable;
}

/**
 * Generates a genuinely browser-decodable MP4 (preferring ffmpeg lavfi H.264+AAC
 * with +faststart moov box when ffmpeg is installed, with pure-Node valid
 * ftyp+moov(trak/mp4a)+mdat fallback). Optionally appends a free/skip padding box
 * after mdat when a minimum byte size is requested for Range-streaming tests.
 */
export function buildDecodableMp4({ durationSec = 4.0, minBytes = 0 } = {}) {
  let base;
  if (hasFfmpeg()) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-chaos-mp4-'));
    const outPath = path.join(tmpDir, 'fixture.mp4');
    try {
      const res = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-loglevel', 'error',
          '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=320x180:rate=15`,
          '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '64k',
          '-movflags', '+faststart',
          outPath,
        ],
        { stdio: 'pipe', timeout: 30_000 },
      );
      if (res.status === 0 && fs.existsSync(outPath)) {
        base = fs.readFileSync(outPath);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  if (!base) {
    base = buildPureNodeDecodableMp4({ durationSec });
  }
  if (minBytes > base.length + 16) {
    const padBody = Buffer.alloc(minBytes - base.length - 8, 0x00);
    const freeBox = isoBox('free', padBody);
    return Buffer.concat([base, freeBox]);
  }
  return base;
}

/**
 * Validates that an MP4 buffer has ftyp, moov, at least one trak, and mdat boxes.
 */
export function inspectMp4Structure(buf) {
  const topBoxes = [];
  let hasMoov = false;
  let hasTrak = false;
  let hasMdat = false;
  let hasFtyp = false;
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (size < 8 || off + size > buf.length) break;
    topBoxes.push({ type, offset: off, size });
    if (type === 'ftyp') hasFtyp = true;
    if (type === 'mdat') hasMdat = true;
    if (type === 'moov') {
      hasMoov = true;
      let inner = off + 8;
      while (inner + 8 <= off + size) {
        const innerSize = buf.readUInt32BE(inner);
        const innerType = buf.subarray(inner + 4, inner + 8).toString('ascii');
        if (innerSize < 8 || inner + innerSize > off + size) break;
        if (innerType === 'trak') hasTrak = true;
        inner += innerSize;
      }
    }
    off += size;
  }
  return {
    valid: hasFtyp && hasMoov && hasTrak && hasMdat,
    hasFtyp,
    hasMoov,
    hasTrak,
    hasMdat,
    topBoxes,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

/**
 * Generates a deterministic valid PNG screenshot with explicit pixel dimensions
 * and realistic ~88 KiB byte size (or custom dimensions).
 */
export function buildScreenshotPng({ width = 1280, height = 720, seed = 0x51a7beef } = {}) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let state = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const band = (y >> 4) & 0xff;
    for (let x = 0; x < width; x += 1) {
      const off = rowStart + 1 + x * 3;
      if ((x & 15) === 0 && (y & 7) === 0) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      }
      raw[off] = (band + ((state >>> 24) & 0x3f)) & 0xff;
      raw[off + 1] = ((x >> 3) + ((state >>> 16) & 0x3f)) & 0xff;
      raw[off + 2] = (180 - (band >> 1) + ((state >>> 8) & 0x1f)) & 0xff;
    }
  }
  const compressed = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

export function buildMediaFixtureBundle({ durationSec = 4.0, mp4MinBytes = 0 } = {}) {
  const mp4 = buildDecodableMp4({ durationSec, minBytes: mp4MinBytes });
  const mp4Info = inspectMp4Structure(mp4);
  if (!mp4Info.valid) {
    throw new Error(`Generated MP4 failed ISO BMFF validation: ${JSON.stringify(mp4Info)}`);
  }
  const ogg = buildDecodableOggOpus({ durationSec });
  const wav = buildDecodableWav({ durationSec });
  const screenshotPng = buildScreenshotPng({ width: 1280, height: 720 });
  const largeScreenshotPng = buildScreenshotPng({ width: 2200, height: 1400, seed: 0x77112233 });
  return {
    mp4: { bytes: mp4, mimeType: 'video/mp4', durationSec, info: mp4Info },
    ogg: {
      bytes: ogg,
      mimeType: 'audio/ogg',
      durationSec,
      sha256: createHash('sha256').update(ogg).digest('hex'),
    },
    wav: {
      bytes: wav,
      mimeType: 'audio/wav',
      durationSec,
      sha256: createHash('sha256').update(wav).digest('hex'),
    },
    screenshotPng: {
      bytes: screenshotPng,
      mimeType: 'image/png',
      width: 1280,
      height: 720,
      sha256: createHash('sha256').update(screenshotPng).digest('hex'),
    },
    largeScreenshotPng: {
      bytes: largeScreenshotPng,
      mimeType: 'image/png',
      width: 2200,
      height: 1400,
      sha256: createHash('sha256').update(largeScreenshotPng).digest('hex'),
    },
  };
}
