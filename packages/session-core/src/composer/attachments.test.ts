import { describe, expect, it } from 'vitest';

import { issueText } from '../i18n/locale';
import {
  buildPromptContent,
  buildSkillActivation,
  formatBytes,
  hasMention,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  mentionToken,
  parseMentionTrigger,
  parseSshHostContext,
  reserveImageFiles,
  reserveUploadFiles,
  validateImageFile,
  validateUploadFile,
  type ComposerAttachment,
  type FileMention,
  type ImageAttachment,
  type UploadAttachment,
} from './attachments';

function mention(path: string, isDir = false): FileMention {
  const name = path.split('/').pop() ?? path;
  return { kind: 'file', path, name, isDir };
}

function image(name: string, size: number, mediaType = 'image/png'): ImageAttachment {
  return {
    kind: 'image',
    name,
    mediaType,
    data: 'aGVsbG8=',
    size,
    previewUrl: `data:${mediaType};base64,aGVsbG8=`,
  };
}

function upload(name: string, size: number, fileId?: string, mediaType = 'text/plain'): UploadAttachment {
  return { kind: 'upload', name, mediaType, size, fileId };
}

describe('validateImageFile', () => {
  it('accepts the server-supported formats', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(validateImageFile({ name: 'a', size: 100, type }, [])).toBeNull();
    }
  });

  it('rejects formats the model providers refuse', () => {
    const problem = validateImageFile({ name: 'a.svg', size: 100, type: 'image/svg+xml' }, []);
    expect(problem?.key).toBe('attach.imageType');
    expect(issueText('en', problem!)).toContain('PNG, JPEG, GIF, and WebP');
    expect(issueText('zh', problem!)).toContain('PNG、JPEG、GIF 和 WebP');
  });

  it('rejects oversized images and oversized totals', () => {
    expect(
      validateImageFile({ name: 'big.png', size: MAX_IMAGE_BYTES + 1, type: 'image/png' }, [])
        ?.key,
    ).toBe('attach.imageTooLarge');
    const current: ComposerAttachment[] = [image('a.png', 15 * 1024 * 1024)];
    expect(
      validateImageFile({ name: 'b.png', size: 6 * 1024 * 1024, type: 'image/png' }, current)?.key,
    ).toBe('attach.totalTooLarge');
  });

  it('carries synchronous reservations across rapid batches for count and byte caps', () => {
    const seven = reserveImageFiles(
      Array.from({ length: 7 }, (_, index) => ({
        name: `${index}.png`, size: 1, type: 'image/png',
      })),
      [],
    );
    const countLimited = reserveImageFiles(
      [
        { name: '7.png', size: 1, type: 'image/png' },
        { name: '8.png', size: 1, type: 'image/png' },
      ],
      seven.next,
    );
    expect(countLimited.accepted).toHaveLength(1);
    expect(countLimited.next).toHaveLength(8);
    expect(countLimited.lastProblem?.key).toBe('attach.tooMany');

    const fullBytes = reserveImageFiles(
      [
        { name: 'a.png', size: 10 * 1024 * 1024, type: 'image/png' },
        { name: 'b.png', size: 10 * 1024 * 1024, type: 'image/png' },
      ],
      [],
    );
    const byteLimited = reserveImageFiles(
      [{ name: 'c.png', size: 1, type: 'image/png' }],
      fullBytes.next,
    );
    expect(byteLimited.accepted).toHaveLength(0);
    expect(byteLimited.lastProblem?.key).toBe('attach.totalTooLarge');
  });
});

describe('mentionToken', () => {
  it('quotes paths with whitespace (TUI convention)', () => {
    expect(mentionToken(mention('src/server.ts'))).toBe('@src/server.ts');
    expect(mentionToken(mention('src/serial port.ts'))).toBe('@"src/serial port.ts"');
    expect(mentionToken(mention('docs', true))).toBe('@docs/');
  });
});

describe('hasMention', () => {
  it('dedupes by path only', () => {
    const list: ComposerAttachment[] = [mention('src/server.ts')];
    expect(hasMention(list, 'src/server.ts')).toBe(true);
    expect(hasMention(list, 'src/other.ts')).toBe(false);
  });
});

describe('buildPromptContent', () => {
  it('folds mentions into the text part before the typed text', () => {
    const content = buildPromptContent('look at this', [mention('src/server.ts')]);
    expect(content).toEqual([{ type: 'text', text: '@src/server.ts\n\nlook at this' }]);
  });

  it('appends images as base64 content parts', () => {
    const content = buildPromptContent('see', [image('a.png', 10)]);
    expect(content).toHaveLength(2);
    expect(content?.[0]).toEqual({ type: 'text', text: 'see' });
    expect(content?.[1]).toEqual({
      type: 'image',
      source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });

  it('sends an image-only message without an empty text part', () => {
    const content = buildPromptContent('  ', [image('a.png', 10)]);
    expect(content).toHaveLength(1);
    expect(content?.[0]?.type).toBe('image');
  });

  it('maps raw offsets into trimmed text and clamps spans at the emitted text length', () => {
    expect(buildPromptContent('  hello  ', [], {
      spans: [{ start: 2, end: 99, kind: 'context' }],
    })).toEqual([{
      type: 'text',
      text: 'hello',
      presentation: { spans: [{ start: 0, end: 5, kind: 'context' }] },
    }]);
  });

  it('keeps presentation aligned after folding a file mention before trimmed text', () => {
    const mentionText = '@src/server.ts';
    expect(buildPromptContent('  hello  ', [mention('src/server.ts')], {
      spans: [{ start: 0, end: 7, kind: 'selection' }],
    })).toEqual([{
      type: 'text',
      text: `${mentionText}\n\nhello`,
      presentation: { spans: [{ start: mentionText.length + 2, end: mentionText.length + 7, kind: 'selection' }] },
    }]);
  });

  it('resends retained image, video and file parts unchanged through both prompt and skill delivery', () => {
    const attachments: ComposerAttachment[] = [
      { kind: 'retained', name: 'image', content: { type: 'image', source: { kind: 'session_media', file_id: 'image-original' } } },
      { kind: 'retained', name: 'video', content: { type: 'video', source: { kind: 'url', url: 'https://example.com/original.mp4' } } },
      { kind: 'retained', name: 'file', content: { type: 'file', file_id: 'file-original', name: 'original.pdf', media_type: 'application/pdf', size: 42 } },
    ];
    const originals = attachments.map((attachment) => attachment.kind === 'retained' ? attachment.content : undefined);
    expect(buildPromptContent('retry', attachments)).toEqual([{ type: 'text', text: 'retry' }, ...originals]);
    expect(buildPromptContent('', attachments)).toEqual(originals);
    expect(buildSkillActivation('--retry', attachments)).toEqual({ args: '--retry', attachments: originals });
  });

  it('returns null when there is nothing to send', () => {
    expect(buildPromptContent('   ', [])).toBeNull();
  });
});

describe('buildSkillActivation', () => {
  it('keeps args text and carries images as wire attachments', () => {
    const result = buildSkillActivation('--fix', [image('a.png', 10)]);
    expect(result.args).toBe('--fix');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.type).toBe('image');
  });

  it('folds file mentions into the args', () => {
    const result = buildSkillActivation('please', [mention('src/server.ts')]);
    expect(result.args).toBe('@src/server.ts please');
    expect(result.attachments).toBeUndefined();
  });
});

describe('parseMentionTrigger', () => {
  it('triggers on @ at the start or after whitespace', () => {
    expect(parseMentionTrigger('@', 1)).toEqual({ start: 0, query: '' });
    expect(parseMentionTrigger('see @ser', 8)).toEqual({ start: 4, query: 'ser' });
  });

  it('ignores email-like and completed tokens', () => {
    expect(parseMentionTrigger('mail a@b', 8)).toBeNull();
    // Cursor past the whitespace: the token is complete, the trigger is over.
    expect(parseMentionTrigger('@done now', 9)).toBeNull();
  });

  it('tracks the cursor position', () => {
    expect(parseMentionTrigger('@ser extra', 4)).toEqual({ start: 0, query: 'ser' });
    expect(parseMentionTrigger('@ser extra', 10)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('formats B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('validateUploadFile', () => {
  it('accepts any media type, including an empty one', () => {
    expect(validateUploadFile({ name: 'a.pdf', size: 100 }, [])).toBeNull();
    expect(validateUploadFile({ name: 'a.bin', size: 100 }, [])).toBeNull();
    expect(validateUploadFile({ name: 'archive.zip', size: 100 }, [])).toBeNull();
  });

  it('rejects oversized files and enforces the shared count cap', () => {
    expect(
      validateUploadFile({ name: 'big.iso', size: MAX_FILE_BYTES + 1 }, [])?.key,
    ).toBe('attach.fileTooLarge');
    const full: ComposerAttachment[] = Array.from({ length: 8 }, (_, index) =>
      upload(`${index}.txt`, 1, `f_${index}`),
    );
    expect(validateUploadFile({ name: 'one-more.txt', size: 1 }, full)?.key).toBe('attach.tooMany');
  });
});

describe('reserveUploadFiles', () => {
  it('creates fileId-less stubs and normalizes an empty MIME to octet-stream', () => {
    const result = reserveUploadFiles(
      [
        { name: 'a.pdf', size: 10, type: 'application/pdf' },
        { name: 'mystery', size: 5, type: '' },
      ],
      [],
    );
    expect(result.accepted).toHaveLength(2);
    expect(result.stubs[0]).toEqual({
      kind: 'upload',
      name: 'a.pdf',
      mediaType: 'application/pdf',
      size: 10,
    });
    expect(result.stubs[1]?.mediaType).toBe('application/octet-stream');
    expect(result.next).toHaveLength(2);
  });

  it('carries reservations across same-tick batches for the count cap', () => {
    const seven = reserveUploadFiles(
      Array.from({ length: 7 }, (_, index) => ({ name: `${index}.txt`, size: 1, type: 'text/plain' })),
      [],
    );
    const limited = reserveUploadFiles(
      [
        { name: '7.txt', size: 1, type: 'text/plain' },
        { name: '8.txt', size: 1, type: 'text/plain' },
      ],
      seven.next,
    );
    expect(limited.accepted).toHaveLength(1);
    expect(limited.lastProblem?.key).toBe('attach.tooMany');
  });

  it('reports the localized size problem', () => {
    const problem = validateUploadFile({ name: 'big.iso', size: MAX_FILE_BYTES + 1 }, []);
    expect(issueText('en', problem!)).toContain('big.iso');
    expect(issueText('zh', problem!)).toContain('上限');
  });
});

describe('buildPromptContent with uploads', () => {
  it('emits uploaded files as real file content parts', () => {
    const content = buildPromptContent('check this', [upload('a.pdf', 10, 'f_1', 'application/pdf')]);
    expect(content).toEqual([
      { type: 'text', text: 'check this' },
      { type: 'file', file_id: 'f_1', name: 'a.pdf', media_type: 'application/pdf', size: 10 },
    ]);
  });

  it('sends a file-only message without an empty text part', () => {
    const content = buildPromptContent('  ', [upload('a.pdf', 10, 'f_1')]);
    expect(content).toEqual([
      { type: 'file', file_id: 'f_1', name: 'a.pdf', media_type: 'text/plain', size: 10 },
    ]);
  });

  it('skips stubs whose upload is still in flight', () => {
    expect(buildPromptContent('hi', [upload('a.pdf', 10)])).toEqual([{ type: 'text', text: 'hi' }]);
    expect(buildPromptContent('   ', [upload('a.pdf', 10)])).toBeNull();
  });

  it('orders text, then images, then files', () => {
    const content = buildPromptContent('see', [
      upload('a.pdf', 10, 'f_1'),
      mention('src/server.ts'),
      image('a.png', 10),
    ]);
    expect(content?.map((part) => part.type)).toEqual(['text', 'image', 'file']);
    expect(content?.[0]).toEqual({ type: 'text', text: '@src/server.ts\n\nsee' });
  });
});

describe('buildSkillActivation with uploads', () => {
  it('carries uploaded files as wire attachments', () => {
    const result = buildSkillActivation('--fix', [upload('a.pdf', 10, 'f_1', 'application/pdf')]);
    expect(result.args).toBe('--fix');
    expect(result.attachments).toEqual([
      { type: 'file', file_id: 'f_1', name: 'a.pdf', media_type: 'application/pdf', size: 10 },
    ]);
  });

  it('keeps images and files together, skipping in-flight uploads', () => {
    const result = buildSkillActivation('go', [image('a.png', 10), upload('pending.pdf', 5)]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.type).toBe('image');
  });
});


describe('SSH hosts as session state, not message content', () => {
  const hosts: ComposerAttachment[] = [{ kind: 'ssh', id: 'example-host', name: 'Example <host>\nname' }];
  it('writes no host into prompt text or skill args, and still sends the message', () => {
    const content = buildPromptContent('Inspect', hosts)!;
    expect(content).toHaveLength(1);
    const text = content[0]!.type === 'text' ? content[0]!.text : '';
    expect(text).toBe('Inspect');
    expect(text).not.toContain('ssh_host_refs');
    const activation = buildSkillActivation('Inspect', hosts);
    expect(activation.args).toBe('Inspect');
  });
  it('keeps file mentions and media intact alongside a joined host', () => {
    const withFile: ComposerAttachment[] = [...hosts, { kind: 'file', path: 'src/app.ts', name: 'app.ts', isDir: false }, image('a.png', 10)];
    const content = buildPromptContent('Look', withFile)!;
    const text = content[0]!.type === 'text' ? content[0]!.text : '';
    expect(text).toBe('@src/app.ts\n\nLook');
    expect(content.some((part) => part.type === 'image')).toBe(true);
    expect(buildSkillActivation('run', withFile).args).toBe('@src/app.ts run');
  });
  it('keeps a legacy host block literal because host state is no longer encoded in text', () => {
    const legacy = 'Inspect\n\n<ssh_host_refs>\n[{"id":"example-host","name":"Example host"}]\n</ssh_host_refs>';
    expect(parseSshHostContext(legacy)).toEqual({ body: legacy, hosts: [] });
  });
  it.each([
    'Plain text',
    '<ssh_host_refs>\nnot JSON\n</ssh_host_refs>',
    '<ssh_host_refs>\n[{"id":42}]\n</ssh_host_refs>',
  ])('leaves unknown host markup verbatim: %s', (text) => {
    expect(parseSshHostContext(text)).toEqual({ body: text, hosts: [] });
  });
});
