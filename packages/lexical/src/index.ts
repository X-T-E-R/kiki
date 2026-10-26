const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9FFF\u3040-\u30FF\uFF00-\uFFEF]+/g;
const MAX_TERM_CHARS = 0xffff;

/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). */
export function tokenize(str: unknown): string[] {
  const s = String(str).toLowerCase();
  const terms: string[] = [];
  const latin = s.match(LATIN);
  if (latin) for (const t of latin) if (t.length <= MAX_TERM_CHARS) terms.push(t);
  const runs = s.match(CJK) ?? [];
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) {
      terms.push(r[i]!);
      if (i + 1 < r.length) terms.push(r[i]! + r[i + 1]!);
    }
  }
  return terms;
}

/** Normalize text for literal matching with Unicode NFKC and lowercase. */
export function normalizeLiteral(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}
