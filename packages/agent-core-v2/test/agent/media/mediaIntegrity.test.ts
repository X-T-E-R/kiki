import { describe, expect, it } from 'vitest';

import { validateMediaBytesIntegrity } from '#/agent/media/mediaIntegrity';

function box(type: string, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.write(type, 4, 'latin1');
  buf.set(payload, 8);
  return buf;
}

function largeBox(type: string, payload: Uint8Array): Buffer {
  const buf = Buffer.alloc(16 + payload.length);
  buf.writeUInt32BE(1, 0);
  buf.write(type, 4, 'latin1');
  buf.writeBigUInt64BE(BigInt(buf.length), 8);
  buf.set(payload, 16);
  return buf;
}

function validMp4(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\x00\x00\x02\x00isommp41', 'latin1')),
    box('free'),
    box('mdat', Buffer.alloc(32, 0xaa)),
    box('moov', Buffer.alloc(16, 0xbb)),
  ]);
}

function validWav(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.write('data', 36, 'latin1');
  return buf;
}

describe('validateMediaBytesIntegrity', () => {
  it('rejects 0-byte payloads for all media types', () => {
    for (const mime of ['video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'image/png']) {
      expect(validateMediaBytesIntegrity(new Uint8Array(0), mime)).toMatchObject({ valid: false });
    }
  });

  it('accepts valid ISO BMFF containers including 64-bit largesize and size=0 trailing mdat', () => {
    expect(validateMediaBytesIntegrity(validMp4(), 'video/mp4')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validMp4(), 'video/quicktime; codecs=avc1')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validMp4(), 'audio/mp4')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validMp4(), 'audio/x-m4a')).toEqual({ valid: true });

    const withLargeBox = Buffer.concat([
      box('ftyp', Buffer.from('mp42\x00\x00\x00\x00mp42isom', 'latin1')),
      largeBox('mdat', Buffer.alloc(24, 0x11)),
      box('moov', Buffer.alloc(8)),
    ]);
    expect(validateMediaBytesIntegrity(withLargeBox, 'video/mp4')).toEqual({ valid: true });

    const trailingZeroSizeMdat = Buffer.alloc(16);
    trailingZeroSizeMdat.writeUInt32BE(0, 0);
    trailingZeroSizeMdat.write('mdat', 4, 'latin1');
    const fastStart = Buffer.concat([
      box('ftyp', Buffer.from('isom\x00\x00\x00\x00', 'latin1')),
      box('moov', Buffer.alloc(8)),
      trailingZeroSizeMdat,
    ]);
    expect(validateMediaBytesIntegrity(fastStart, 'video/mp4')).toEqual({ valid: true });
  });

  it('rejects unfinalized MP4 missing moov, truncated boxes, invalid sizes, and non-ISOBMFF headers', () => {
    const unfinalized = Buffer.concat([
      box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2avc1mp41', 'latin1')),
      box('free'),
      box('mdat', Buffer.alloc(1024, 0x22)),
    ]);
    const missingMoov = validateMediaBytesIntegrity(unfinalized, 'video/mp4');
    expect(missingMoov).toMatchObject({ valid: false });
    if (!missingMoov.valid) expect(missingMoov.reason).toContain('moov');

    const truncated = validMp4().subarray(0, validMp4().length - 4);
    expect(validateMediaBytesIntegrity(truncated, 'video/mp4')).toMatchObject({ valid: false });

    const badSmallSize = Buffer.alloc(24);
    badSmallSize.writeUInt32BE(4, 0);
    badSmallSize.write('ftyp', 4, 'latin1');
    expect(validateMediaBytesIntegrity(badSmallSize, 'video/mp4')).toMatchObject({ valid: false });

    const nonIso = Buffer.concat([Buffer.from('NOT_ISOBMFF_DATA'), box('moov', Buffer.alloc(8))]);
    expect(validateMediaBytesIntegrity(nonIso, 'video/mp4')).toMatchObject({ valid: false });

    const truncatedUuid = Buffer.concat([
      box('ftyp', Buffer.from('isom\x00\x00\x02\x00isommp41', 'latin1')),
      box('uuid'),
      box('moov', Buffer.alloc(8)),
    ]);
    expect(validateMediaBytesIntegrity(truncatedUuid, 'video/mp4')).toMatchObject({ valid: false });

    const validUuid = Buffer.concat([
      box('ftyp', Buffer.from('isom\x00\x00\x02\x00isommp41', 'latin1')),
      box('uuid', Buffer.alloc(16, 0x33)),
      box('moov', Buffer.alloc(8)),
    ]);
    expect(validateMediaBytesIntegrity(validUuid, 'video/mp4')).toEqual({ valid: true });

    expect(validateMediaBytesIntegrity(Buffer.alloc(12), 'video/mp4')).toMatchObject({ valid: false });
  });

  it('validates WebM/Matroska EBML headers and minimum size', () => {
    const validWebm = Buffer.alloc(32);
    validWebm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(validateMediaBytesIntegrity(validWebm, 'video/webm')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validWebm, 'video/x-matroska')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validWebm, 'audio/webm')).toEqual({ valid: true });

    expect(validateMediaBytesIntegrity(validWebm.subarray(0, 16), 'video/webm')).toMatchObject({ valid: false });
    expect(validateMediaBytesIntegrity(Buffer.alloc(64, 0x00), 'video/webm')).toMatchObject({ valid: false });
  });

  it('validates WAV, Ogg/Opus, FLAC, MPEG/AAC, and generic video/audio containers', () => {
    expect(validateMediaBytesIntegrity(validWav(), 'audio/wav')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validWav(), 'audio/x-wav')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validWav().subarray(0, 43), 'audio/wav')).toMatchObject({ valid: false });
    expect(validateMediaBytesIntegrity(Buffer.alloc(44, 0x00), 'audio/wav')).toMatchObject({ valid: false });

    const validOgg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24)]);
    expect(validateMediaBytesIntegrity(validOgg, 'audio/ogg')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validOgg, 'audio/opus')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validOgg.subarray(0, 27), 'audio/ogg')).toMatchObject({ valid: false });

    const validFlac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(38)]);
    expect(validateMediaBytesIntegrity(validFlac, 'audio/flac')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(validFlac.subarray(0, 41), 'audio/flac')).toMatchObject({ valid: false });

    expect(validateMediaBytesIntegrity(Buffer.from('ID3\x03\x00\x00'), 'audio/mpeg')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mp3')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(Buffer.from('ADIF\x00\x00'), 'audio/aac')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(Buffer.from('bad!'), 'audio/mpeg')).toMatchObject({ valid: false });
    expect(validateMediaBytesIntegrity(Buffer.from([0xff, 0xfb]), 'audio/mpeg')).toMatchObject({ valid: false });

    expect(validateMediaBytesIntegrity(Buffer.alloc(16, 0x55), 'video/x-msvideo')).toEqual({ valid: true });
    expect(validateMediaBytesIntegrity(Buffer.alloc(15, 0x55), 'video/x-msvideo')).toMatchObject({ valid: false });
  });
});
