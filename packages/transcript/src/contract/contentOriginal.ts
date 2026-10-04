import type { ContentRef } from './content';

/** Only existing tool input/output and task output consumers expose an original file. */
export function contentOriginalFileId(agentId: string, ref: ContentRef): string | undefined {
  const field = ref.path[0];
  if (ref.path.length !== 1 ||
    !(ref.source.kind === 'frame' && (field === 'input' || field === 'output') || ref.source.kind === 'task' && field === 'outputTail')) return undefined;
  const payload = JSON.stringify([agentId, ref.source.kind, ref.source.id, ref.source.turnId ?? '', ref.source.stepId ?? '', field, ref.revision]);
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `raw:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}
