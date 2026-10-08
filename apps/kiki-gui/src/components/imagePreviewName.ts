const WINDOWS_PATH = /^[A-Za-z]:[\\/]/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const OPAQUE_PREFIX = /^(?:data|blob|blobref|opaque|base64|kimi-file):/iu;
const OPAQUE_WORD = /^(?:data|blob|opaque|base64|unknown|undefined|null)$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_URL_ESCAPE = /%[0-9a-f]{2}/iu;
const BASE64_TOKEN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u;
const IMAGE_PAYLOAD_PREFIX = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|Qk0|SUkq|TU0A|PHN2Zy|JVBER|UEsDB)/u;

function looksLikeEncodedPayload(value: string): boolean {
  return BASE64_TOKEN.test(value) && IMAGE_PAYLOAD_PREFIX.test(value);
}

function candidateText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (
    candidate === '' ||
    CONTROL_CHARACTER.test(candidate) ||
    OPAQUE_PREFIX.test(candidate) ||
    OPAQUE_WORD.test(candidate) ||
    looksLikeEncodedPayload(candidate) ||
    (URI_SCHEME.test(candidate) && !WINDOWS_PATH.test(candidate)) ||
    candidate.includes('://') ||
    candidate.startsWith('//') ||
    ENCODED_URL_ESCAPE.test(candidate)
  ) return undefined;
  return candidate;
}

function legalPath(value: string): boolean {
  if (value.includes('?') || value.includes('#')) return false;
  if (value.startsWith('//')) return false;
  return !URI_SCHEME.test(value) || WINDOWS_PATH.test(value);
}

function basename(value: string): string | undefined {
  const normalized = value.replace(/[\\/]+$/u, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const leaf = index === -1 ? normalized : normalized.slice(index + 1);
  const candidate = candidateText(leaf);
  if (candidate === undefined || candidate === '.' || candidate === '..' || URI_SCHEME.test(candidate)) return undefined;
  return candidate;
}

function nameCandidate(value: unknown): string | undefined {
  const candidate = candidateText(value);
  return candidate !== undefined && legalPath(candidate) ? basename(candidate) : undefined;
}

function pathCandidate(value: unknown): string | undefined {
  const candidate = candidateText(value);
  return candidate !== undefined && legalPath(candidate) ? basename(candidate) : undefined;
}

export interface ImagePreviewNameSource {
  readonly name?: unknown;
  readonly metadataName?: unknown;
  readonly path?: unknown;
}

export function safeImagePreviewName(source: ImagePreviewNameSource): string | undefined {
  return nameCandidate(source.name) ?? nameCandidate(source.metadataName) ?? pathCandidate(source.path);
}

export function imagePreviewLabel(source: ImagePreviewNameSource, fallback: string): string {
  return safeImagePreviewName(source) ?? fallback;
}

export function imagePreviewDownloadName(source: ImagePreviewNameSource, fallback = 'image'): string {
  return safeImagePreviewName(source) ?? fallback;
}
