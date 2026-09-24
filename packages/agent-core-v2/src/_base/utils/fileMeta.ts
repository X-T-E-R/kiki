import { extname } from 'node:path';

import { classifyTextSample } from '#/_base/text/encoding';

export { FS_BINARY_NONPRINTABLE_FRACTION } from '#/_base/text/encoding';

export const FS_BINARY_SAMPLE_BYTES = 4096;

export interface FileMetaStat {
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export function detectBinary(buf: Uint8Array): boolean {
  return classifyTextSample(buf).isBinary;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return Math.max(0, n);
}

export function buildEtag(st: FileMetaStat): string {
  const mtime = Math.floor(st.mtimeMs ?? 0);
  const ino = st.ino ?? 0;
  return [mtime.toString(36), st.size.toString(36), ino.toString(36)].join('-');
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.pdf': 'application/pdf',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'application/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/rust',
  '.go': 'text/x-go',
};

export function guessMime(path: string, isBinary: boolean): string {
  const ext = extname(path).toLowerCase();
  const mapped = EXT_TO_MIME[ext];
  if (mapped !== undefined) return mapped;
  return isBinary ? 'application/octet-stream' : 'text/plain';
}

const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shellscript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

export function guessLanguageId(path: string): string | undefined {
  return EXT_TO_LANGUAGE[extname(path).toLowerCase()];
}
