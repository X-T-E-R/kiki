/**
 * Is a font family installed? Browsers expose no list of local fonts, and
 * `document.fonts.check` answers true for any family it has no FontFace for,
 * so the check measures instead: a string drawn in `"<name>", <generic>`
 * that comes out the same width as the bare generic, for every generic
 * tried, fell back — the family is not there.
 */

export type FontPresence = 'present' | 'missing' | 'unknown';

const SAMPLE = 'mmmmmmmmmmlli10WQ@#永和九年';
const GENERICS = ['monospace', 'serif', 'sans-serif'] as const;
const cache = new Map<string, FontPresence>();

export function detectFont(family: string): FontPresence {
  const name = family.trim();
  if (name === '') return 'unknown';
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  } catch {
    context = null;
  }
  if (context === null) return 'unknown';
  const quoted = `"${name.replace(/["\\]/g, '')}"`;
  let present = false;
  for (const generic of GENERICS) {
    context.font = `32px ${generic}`;
    const base = context.measureText(SAMPLE).width;
    context.font = `32px ${quoted}, ${generic}`;
    if (context.measureText(SAMPLE).width !== base) {
      present = true;
      break;
    }
  }
  const result: FontPresence = present ? 'present' : 'missing';
  cache.set(name, result);
  return result;
}

/** Characters a stored font stack may hold (mirrors the skin store's check). */
const NAME_ALLOWED = /[^\p{L}\p{N} \-_.]/gu;

/** A typed family name, trimmed to what a stack can safely carry. */
export function cleanFontName(input: string): string {
  return input.replace(NAME_ALLOWED, '').replace(/\s+/g, ' ').trimStart().slice(0, 64);
}

/** `Name` first, then the role's own fallbacks, so missing glyphs still land on a deliberate face. */
export function fontStack(name: string, fallback: string): string {
  return `'${name.trim()}', ${fallback}`;
}

/** The first family of a stack, unquoted — the name a user typed. */
export function firstFamily(stack: string): string {
  const head = stack.split(',', 1)[0] ?? '';
  return head.trim().replace(/^['"]|['"]$/g, '');
}
