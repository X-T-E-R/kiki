import { createHash } from 'node:crypto';

export interface LocalExecutorSessionSource {
  readonly localId: string;
  readonly executorId: string;
  readonly engine: 'claude' | 'codex';
  readonly externalId: string;
  readonly home: string;
}

export function localSessionKikiId(source: LocalExecutorSessionSource): string {
  const hash = createHash('sha256').update(JSON.stringify([
    'kiki-local-session-v1', source.engine, source.home, source.externalId,
  ])).digest('hex');
  return `session_${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function localSourceFromRef(ref: Readonly<Record<string, unknown>> | undefined): LocalExecutorSessionSource | undefined {
  const source = ref?.['localSource'];
  if (source === undefined || source === null || typeof source !== 'object') return undefined;
  const value = source as Record<string, unknown>;
  if (typeof value['localId'] !== 'string' || typeof value['executorId'] !== 'string' ||
      typeof value['externalId'] !== 'string' || typeof value['home'] !== 'string' ||
      (value['engine'] !== 'claude' && value['engine'] !== 'codex')) return undefined;
  return value as unknown as LocalExecutorSessionSource;
}
