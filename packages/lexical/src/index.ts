const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9FFF\u3040-\u30FF\uFF00-\uFFEF]+/g;
const NON_ASCII = /[^\x00-\x7f]/;
const MAX_TERM_CHARS = 0xffff;

/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). */
export function tokenize(str: unknown): string[] {
  const s = String(str).toLowerCase();
  const terms: string[] = [];
  const latin = s.match(LATIN);
  if (latin) for (const t of latin) if (t.length <= MAX_TERM_CHARS) terms.push(t);
  if (NON_ASCII.test(s)) {
    const runs = s.match(CJK);
    if (runs) {
      for (const r of runs) {
        for (let i = 0; i < r.length; i++) {
          terms.push(r[i]!);
          if (i + 1 < r.length) terms.push(r[i]! + r[i + 1]!);
        }
      }
    }
  }
  return terms;
}

/** Normalize text for literal matching with Unicode NFKC and lowercase. */
export function normalizeLiteral(text: string): string {
  return NON_ASCII.test(text) ? text.normalize('NFKC').toLowerCase() : text.toLowerCase();
}
