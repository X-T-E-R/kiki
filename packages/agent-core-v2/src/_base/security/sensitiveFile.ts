const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

const SENSITIVE_PATH_SUFFIX_RE = /[/\\]\.(?:aws|gcp)[/\\]credentials(?:[/\\]|$)/i;

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
export const SENSITIVE_DOT_VARIANT_SUFFIXES = [
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
] as const;
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set<string>(SENSITIVE_DOT_VARIANT_SUFFIXES);

function fastBasename(path: string): string {
  let end = path.length;
  while (end > 0) {
    const ch = path.charCodeAt(end - 1);
    if (ch !== 47 && ch !== 92) break;
    end -= 1;
  }
  if (end === 0) return '';
  const slash = Math.max(path.lastIndexOf('/', end - 1), path.lastIndexOf('\\', end - 1));
  const start = slash + 1;
  if (start === 0 && end === 2 && path.charCodeAt(1) === 58) return '';
  return start === 0 && end === path.length ? path : path.slice(start, end);
}

export function isSensitiveFile(path: string): boolean {
  const name = fastBasename(path);
  let comparableName = name.toLowerCase();
  const hasAds = comparableName.endsWith('::$data');
  if (hasAds) comparableName = comparableName.slice(0, -7);

  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  const first = comparableName.charCodeAt(0);
  if (first === 105 || first === 99) {
    for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
      if (comparableName === prefix) return true;
      if (comparableName.length > prefix.length && comparableName.startsWith(prefix)) {
        const suffix = comparableName.slice(prefix.length);
        const next = suffix[0];
        if (next === '-' || next === '_') return true;
        if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIX_SET.has(suffix)) return true;
      }
    }
  }

  if (path.length >= 16) {
    const checkPath = hasAds ? path.slice(0, -7) : path;
    if (SENSITIVE_PATH_SUFFIX_RE.test(checkPath)) return true;
  }

  return false;
}
