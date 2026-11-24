export type MediaIntegrityResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const ISO_BMFF_MIMES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
  'video/x-m4v',
  'audio/mp4',
  'audio/x-m4a',
]);

const ISO_BMFF_INITIAL_BOX_TYPES: ReadonlySet<string> = new Set([
  'ftyp',
  'styp',
  'moov',
  'wide',
  'free',
  'skip',
  'mdat',
  'pdin',
]);

const WEBM_MKV_MIMES: ReadonlySet<string> = new Set([
  'video/webm',
  'video/x-matroska',
  'audio/webm',
]);

const WAV_MIMES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
]);

const OGG_MIMES: ReadonlySet<string> = new Set([
  'audio/ogg',
  'audio/opus',
  'video/ogg',
]);

const MPEG_AAC_MIMES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
]);

function normalizeMime(mimeType: string): string {
  const semi = mimeType.indexOf(';');
  return (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim().toLowerCase();
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCodePoint(bytes[offset + i]!);
  }
  return out;
}

function validateIsoBmff(bytes: Uint8Array): MediaIntegrityResult {
  if (bytes.length < 16) {
    return { valid: false, reason: 'ISO BMFF container is truncated (fewer than 16 bytes)' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let hasMoov = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return { valid: false, reason: 'ISO BMFF container has a truncated box header' };
    }
    const size32 = view.getUint32(offset, false);
    const boxType = asciiAt(bytes, offset + 4, 4);
    if (offset === 0 && !ISO_BMFF_INITIAL_BOX_TYPES.has(boxType)) {
      return { valid: false, reason: `unrecognized ISO BMFF header box '${boxType}'` };
    }

    let headerSize: number;
    let boxSize: number;
    if (size32 === 1) {
      if (offset + 16 > bytes.length) {
        return { valid: false, reason: `ISO BMFF '${boxType}' box has a truncated 64-bit size header` };
      }
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      headerSize = 16;
      boxSize = high * 4294967296 + low;
      if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) {
        return { valid: false, reason: `ISO BMFF '${boxType}' box has an invalid 64-bit size` };
      }
    } else if (size32 === 0) {
      headerSize = 8;
      boxSize = bytes.length - offset;
    } else {
      headerSize = 8;
      boxSize = size32;
      if (boxSize < headerSize) {
        return { valid: false, reason: `ISO BMFF '${boxType}' box has an invalid size (${String(boxSize)})` };
      }
    }

    if (boxType === 'uuid') {
      headerSize += 16;
      if (boxSize < headerSize) {
        return { valid: false, reason: 'ISO BMFF \'uuid\' box is truncated before its 16-byte usertype' };
      }
    }

    const end = offset + boxSize;
    if (end > bytes.length) {
      return {
        valid: false,
        reason: `ISO BMFF '${boxType}' box is truncated (declared end ${String(end)} exceeds ${String(bytes.length)} bytes)`,
      };
    }

    if (boxType === 'moov' && boxSize >= 8) {
      hasMoov = true;
    }
    offset = end;
  }

  if (!hasMoov) {
    return {
      valid: false,
      reason: 'ISO BMFF container is missing its moov metadata atom (file may be unfinalized or truncated)',
    };
  }
  return { valid: true };
}

/**
 * Validates container-level structural integrity using positioned slice reads so
 * large local media files never need to be buffered wholly into memory.
 */
export async function validateMediaFileIntegrity(
  readSlice: (offset: number, length: number) => Promise<Uint8Array>,
  size: number,
  mimeType: string,
): Promise<MediaIntegrityResult> {
  if (size <= 0) {
    return { valid: false, reason: 'media payload is empty (0 bytes)' };
  }
  const mime = normalizeMime(mimeType);
  if (ISO_BMFF_MIMES.has(mime)) {
    if (size < 16) {
      return { valid: false, reason: 'ISO BMFF container is truncated (fewer than 16 bytes)' };
    }
    let offset = 0;
    let hasMoov = false;
    let boxes = 0;
    while (offset < size) {
      if (++boxes > 65_536) {
        return { valid: false, reason: 'ISO BMFF container exceeds top-level box limit' };
      }
      if (offset + 8 > size) {
        return { valid: false, reason: 'ISO BMFF container has a truncated box header' };
      }
      const headerLen = Math.min(16, size - offset);
      const header = await readSlice(offset, headerLen);
      if (header.byteLength < 8) {
        return { valid: false, reason: 'ISO BMFF container has a truncated box header' };
      }
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const size32 = view.getUint32(0, false);
      const boxType = asciiAt(header, 4, 4);
      if (offset === 0 && !ISO_BMFF_INITIAL_BOX_TYPES.has(boxType)) {
        return { valid: false, reason: `unrecognized ISO BMFF header box '${boxType}'` };
      }
      let headerSize: number;
      let boxSize: number;
      if (size32 === 1) {
        if (offset + 16 > size || header.byteLength < 16) {
          return { valid: false, reason: `ISO BMFF '${boxType}' box has a truncated 64-bit size header` };
        }
        const high = view.getUint32(8, false);
        const low = view.getUint32(12, false);
        headerSize = 16;
        boxSize = high * 4294967296 + low;
        if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) {
          return { valid: false, reason: `ISO BMFF '${boxType}' box has an invalid 64-bit size` };
        }
      } else if (size32 === 0) {
        headerSize = 8;
        boxSize = size - offset;
      } else {
        headerSize = 8;
        boxSize = size32;
        if (boxSize < headerSize) {
          return { valid: false, reason: `ISO BMFF '${boxType}' box has an invalid size (${String(boxSize)})` };
        }
      }
      if (boxType === 'uuid') {
        headerSize += 16;
        if (boxSize < headerSize) {
          return { valid: false, reason: 'ISO BMFF \'uuid\' box is truncated before its 16-byte usertype' };
        }
      }
      const end = offset + boxSize;
      if (end > size) {
        return {
          valid: false,
          reason: `ISO BMFF '${boxType}' box is truncated (declared end ${String(end)} exceeds ${String(size)} bytes)`,
        };
      }
      if (boxType === 'moov' && boxSize >= 8) {
        hasMoov = true;
      }
      offset = end;
    }
    if (!hasMoov) {
      return {
        valid: false,
        reason: 'ISO BMFF container is missing its moov metadata atom (file may be unfinalized or truncated)',
      };
    }
    return { valid: true };
  }
  const head = await readSlice(0, Math.min(64, size));
  return validateMediaBytesIntegrity(head, mimeType);
}

/**
 * Validates container-level structural integrity of encoded media bytes before
 * admitting them into conversation history or sending them to a model provider.
 */
export function validateMediaBytesIntegrity(
  bytes: Uint8Array,
  mimeType: string,
): MediaIntegrityResult {
  if (bytes.length === 0) {
    return { valid: false, reason: 'media payload is empty (0 bytes)' };
  }

  const mime = normalizeMime(mimeType);

  if (ISO_BMFF_MIMES.has(mime)) {
    return validateIsoBmff(bytes);
  }

  if (WEBM_MKV_MIMES.has(mime)) {
    if (
      bytes.length < 32 ||
      bytes[0] !== 0x1a ||
      bytes[1] !== 0x45 ||
      bytes[2] !== 0xdf ||
      bytes[3] !== 0xa3
    ) {
      return { valid: false, reason: 'WebM/Matroska container is truncated or missing its EBML header' };
    }
    return { valid: true };
  }

  if (WAV_MIMES.has(mime)) {
    if (bytes.length < 44 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WAVE') {
      return { valid: false, reason: 'WAV audio is truncated or missing its RIFF/WAVE header' };
    }
    return { valid: true };
  }

  if (OGG_MIMES.has(mime)) {
    if (bytes.length < 28 || asciiAt(bytes, 0, 4) !== 'OggS') {
      return { valid: false, reason: 'Ogg media is truncated or missing its OggS header' };
    }
    return { valid: true };
  }

  if (mime === 'audio/flac') {
    if (bytes.length < 42 || asciiAt(bytes, 0, 4) !== 'fLaC') {
      return { valid: false, reason: 'FLAC audio is truncated or missing its fLaC header' };
    }
    return { valid: true };
  }

  if (MPEG_AAC_MIMES.has(mime)) {
    const hasId3 = bytes.length >= 4 && asciiAt(bytes, 0, 3) === 'ID3';
    const hasSync = bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    const hasAdif = bytes.length >= 4 && asciiAt(bytes, 0, 4) === 'ADIF';
    if (!hasId3 && !hasSync && !hasAdif) {
      return { valid: false, reason: 'MPEG/AAC audio is truncated or missing a valid header or frame sync' };
    }
    return { valid: true };
  }

  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    if (bytes.length < 16) {
      return { valid: false, reason: 'media payload is truncated (fewer than 16 bytes)' };
    }
  }

  return { valid: true };
}
