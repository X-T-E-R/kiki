const OUTBOUND_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

const SOURCE_EXTENSION_RE = /(?=\.[A-Za-z0-9]*[A-Za-z])(\.(?:tar\.(?:gz|bz2|xz|zst)|[A-Za-z0-9]{1,12}))$/u;
const HAS_REAL_EXTENSION_RE = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,12}$/u;

function sanitizeOutboundName(raw: string | undefined): string {
  return (raw ?? '').replaceAll(/[/\\\0]/gu, '').trim();
}

/** Resolves an IM outbound attachment filename, preserving or inferring the file extension when a display title omits it. */
export function resolveOutboundFilename(
  preferred: string | undefined,
  fallbackFilename: string | undefined,
  mediaType: string,
): string {
  const safePreferred = sanitizeOutboundName(preferred);
  const safeFallback = sanitizeOutboundName(fallbackFilename);
  const base = safePreferred || safeFallback || 'file';
  if (HAS_REAL_EXTENSION_RE.test(base)) return base;
  const sourceMatch = SOURCE_EXTENSION_RE.exec(safeFallback);
  const normalizedMime = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const ext = sourceMatch?.[1] ?? OUTBOUND_MEDIA_EXTENSIONS[normalizedMime];
  return ext !== undefined ? `${base}${ext}` : base;
}
