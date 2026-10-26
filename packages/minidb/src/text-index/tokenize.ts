// src/text-index/tokenize.ts
//
// Tokenizer of the full-text index: Latin/number words + CJK unigrams &
// bigrams (no dictionary, zero dependencies, works for Chinese without a
// segmenter), plus the document text extraction shared with the generation
// build's worker. This file is part of the worker's import closure, so every
// relative import carries an explicit `.ts` specifier (see the IMPORT NOTE in
// worker/text-build-core.ts).

import { tokenize } from '@kiki/lexical';
import { getPath } from '../query.ts';

export { tokenize };

// The same postings uint16 limit in UTF-8 BYTES (encodeRecord's unit). A
// custom tokenizer's output is validated against it at every write boundary
// (tokensFor): an overlong term rejects the write loudly instead of poisoning
// the next postings rebuild (review #27).
export const MAX_TERM_BYTES = 0xffff;

export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function stringLeaves(obj: unknown, acc: string[] = []): string[] {
  if (obj === null || obj === undefined) return acc;
  if (typeof obj === 'string') {
    acc.push(obj);
    return acc;
  }
  if (typeof obj !== 'object') return acc;
  for (const v of Object.values(obj as Record<string, unknown>)) stringLeaves(v, acc);
  return acc;
}

/** Extract the indexable text of a document (shared with the generation
 *  build's worker: fields mode joins the configured paths, otherwise every
 *  string leaf). Internal to the package. */
export function extractText(fields: readonly string[] | null, doc: unknown): string {
  if (fields && fields.length) {
    return fields
      .map((f) => getPath(doc, f))
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return stringLeaves(doc).join(' ');
}
