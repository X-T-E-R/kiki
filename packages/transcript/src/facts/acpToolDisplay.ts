import { parsePartialJsonObject } from './partialJson';

export function parseAcpToolInput(rawInput: unknown): unknown {
  if (typeof rawInput !== 'string') return rawInput;
  return parsePartialJsonObject(rawInput)?.value ?? rawInput;
}
