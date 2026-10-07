import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { expect, it } from 'vitest';

import type { FileMeta, GetResult, IFileService, SaveOptions } from '@kiki/agent-core-v2/app/file/fileService';
import { projectPresentedText } from '@kiki/transcript';
import { prepareThreadRefContext } from '../../../../session-core/src/composer/threadRefs';
import { projectMessageContent } from '../../../../session-core/src/session/transcript/classify';

import type { PromptSubmission } from '../../../src/protocol/rest-prompt';
import { contentToCoreParts, resolvePromptMediaFiles } from '../../../src/lib/promptMedia';
import { projectPromptContentParts } from '../../../src/services/messages/messageProjection';

type StoredFile = { readonly meta: FileMeta; readonly bytes: Buffer };

function mockFileService(): IFileService {
  const files = new Map<string, StoredFile>();
  let nextId = 0;
  return {
    _serviceBrand: undefined,
    async save(source: Readable, filename: string, options: SaveOptions = {}): Promise<FileMeta> {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
      const bytes = Buffer.concat(chunks);
      const meta: FileMeta = {
        id: `f_prompt_${nextId++}`,
        name: options.name ?? filename,
        media_type: options.mimeType ?? 'application/octet-stream',
        size: bytes.length,
        created_at: new Date(0).toISOString(),
      };
      files.set(meta.id, { meta, bytes });
      return meta;
    },
    async get(fileId: string): Promise<GetResult> {
      const stored = files.get(fileId);
      if (stored === undefined) throw new Error(`missing mock upload: ${fileId}`);
      return { meta: stored.meta, stream: () => Readable.from(stored.bytes) };
    },
    async delete(fileId: string): Promise<void> {
      files.delete(fileId);
    },
  };
}

const REF_ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const REF_INFO = {
  sessionId: REF_ID,
  hostId: 'host-example',
  title: 'Prompt display proof',
  workspaceId: 'workspace-example',
  workspaceName: 'kiki',
  cwd: 'C:/workspace/kiki',
  status: 'idle' as const,
  updatedAt: '2026-01-01T12:00:00.000Z',
};

it('keeps generated prompt context and attachment notices hidden while preserving their media metadata', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  let tempDir: string | undefined;
  let preparedMedia: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
  try {
    await mkdir(scratchRoot, { recursive: true });
    tempDir = await mkdtemp(join(scratchRoot, 'prompt-media-presentation-'));
    const fileBytes = Buffer.from('%PDF-1.4 mock report bytes');
    const files = mockFileService();
    const upload = await files.save(Readable.from(fileBytes), 'report.pdf', { mimeType: 'application/pdf' });
    const body = `Compare this with /s/${REF_ID}`;
    const preparedText = prepareThreadRefContext(body, () => REF_INFO);
    const input = [
      { type: 'text', text: preparedText.text, presentation: preparedText.presentation },
      { type: 'file', file_id: upload.id, name: upload.name, media_type: upload.media_type, size: upload.size },
    ] satisfies PromptSubmission['content'];

    preparedMedia = await resolvePromptMediaFiles(input, files, tempDir);
    const preparedReferenceSpan = { start: body.length, end: preparedText.text.length, kind: 'context' as const };
    expect(preparedText.presentation).toEqual({ spans: [preparedReferenceSpan] });
    expect(preparedMedia.content[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });

    const preparedNotice = preparedMedia.content[1];
    expect(preparedNotice?.type).toBe('text');
    if (preparedNotice?.type !== 'text') throw new Error('resolvePromptMediaFiles did not produce an attachment notice');
    const attachedPath = join(tempDir, `${upload.id}-${upload.name}`);
    const expectedNotice = `Attached file "${upload.name}" (${upload.media_type}, ${upload.size} bytes): ${attachedPath} — open it with the Read tool`;
    const expectedAttachment = { path: attachedPath, name: upload.name, mime: upload.media_type, size: upload.size };
    expect(preparedNotice.text).toBe(expectedNotice);
    expect(preparedNotice.text).toContain('open it with the Read tool');
    expect(preparedNotice.presentation).toEqual({ spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] });

    const coreParts = contentToCoreParts(preparedMedia.content);
    expect(coreParts[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });
    expect(coreParts[1]).toEqual({ type: 'text', text: expectedNotice, presentation: { spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] } });
    expect(coreParts[1]?.type === 'text' ? coreParts[1].text : '').toContain('open it with the Read tool');

    const projectedContent = projectPromptContentParts(coreParts);
    expect(projectedContent[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });
    expect(projectedContent[1]).toEqual({ type: 'text', text: expectedNotice, presentation: { spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] } });

    const projected = projectMessageContent(projectedContent);
    expect(projected.presentation?.spans[0]).toEqual(preparedReferenceSpan);
    expect(projected.presentation?.spans[1]).toEqual({ start: preparedText.text.length + 1, end: preparedText.text.length + 1 + expectedNotice.length, kind: 'attachment', attachment: expectedAttachment });
    expect(projected.media).toEqual([{ kind: 'file', path: attachedPath, name: upload.name, mime: upload.media_type, size: upload.size }]);
    expect(projectPresentedText(projected.text, projected.presentation)).toBe(`${body}\n`);
    expect(projectPresentedText(projected.text, projected.presentation)).not.toContain(expectedNotice);
    expect(projected.text).toContain('open it with the Read tool');

    const userReadNotice = 'Attached file "report.pdf" (application/pdf, 25 bytes): C:/user/report.pdf — open it with the Read tool';
    const authoredXml = `${body}\n\n<thread_refs>\nuser-authored note\n</thread_refs>`;
    for (const authored of [userReadNotice, authoredXml]) {
      const rawProjection = projectMessageContent([{ type: 'text', text: authored }]);
      expect(rawProjection.presentation).toBeUndefined();
      expect(projectPresentedText(rawProjection.text, rawProjection.presentation)).toBe(authored);
    }
  } finally {
    await preparedMedia?.discard();
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  }
});
