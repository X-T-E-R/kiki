import { isAbsolute } from 'pathe';

const DROPFILES_HEADER_BYTES = 20;

function decodeNarrowAnsiSlice(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: false }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
    }
  }
}
function isAbsoluteForPlatform(filePath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
  }
  return isAbsolute(filePath);
}

/**
 * Parses a Windows `CF_HDROP` (`DROPFILES` struct + null-terminated path list) buffer
 * returned by `clipboard.readBuffer('CF_HDROP')`, matching `clipboard_files.rs` multi-file
 * Unicode support without spawning PowerShell.
 */
export function parseWindowsCfHdropBuffer(buffer: Uint8Array): string[] | null {
  if (buffer.byteLength < DROPFILES_HEADER_BYTES) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pFiles = view.getUint32(0, true);
  const fWide = view.getInt32(16, true) !== 0;
  if (pFiles < DROPFILES_HEADER_BYTES || pFiles >= buffer.byteLength) return null;

  const payload = buffer.subarray(pFiles);
  const paths: string[] = [];

  if (fWide) {
    const decoder = new TextDecoder('utf-16le', { fatal: false, ignoreBOM: false });
    let cursor = 0;
    while (cursor + 1 < payload.byteLength) {
      let end = cursor;
      while (end + 1 < payload.byteLength) {
        if (payload[end] === 0 && payload[end + 1] === 0) break;
        end += 2;
      }
      if (end === cursor) break;
      const decoded = decoder.decode(payload.subarray(cursor, end));
      if (!isAbsoluteForPlatform(decoded, 'win32')) return null;
      paths.push(decoded);
      cursor = end + 2;
    }
  } else {
    let cursor = 0;
    while (cursor < payload.byteLength) {
      let end = cursor;
      while (end < payload.byteLength && payload[end] !== 0) {
        end += 1;
      }
      if (end === cursor) break;
      const decoded = decodeNarrowAnsiSlice(payload.subarray(cursor, end));
      if (!isAbsoluteForPlatform(decoded, 'win32')) return null;
      paths.push(decoded);
      cursor = end + 1;
    }
  }

  return paths.length > 0 ? paths : null;
}
