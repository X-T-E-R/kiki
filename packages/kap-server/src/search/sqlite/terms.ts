import { tokenize } from '@kiki/lexical';

export function encodeTerm(term: string): string {
  const hex = Buffer.from(term, 'utf8').toString('hex');
  return ['b', ...hex.match(/.{1,128}/g)!.map((chunk) => `x${chunk}`), 'e'].join(' ');
}

export function encodeTerms(text: string): string {
  return tokenize(text).map(encodeTerm).join(' ');
}
