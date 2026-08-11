import { describe, expect, it } from 'vitest';

import {
  buildPromptContent,
  buildSkillActivation,
  formatBytes,
  hasMention,
  MAX_IMAGE_BYTES,
  mentionToken,
  parseMentionTrigger,
  validateImageFile,
  type ComposerAttachment,
  type FileMention,
  type ImageAttachment,
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

describe('validateImageFile', () => {
  it('accepts the server-supported formats', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(validateImageFile({ name: 'a', size: 100, type }, [])).toBeNull();
    }
  });

  it('rejects formats the model providers refuse', () => {
    const problem = validateImageFile({ name: 'a.svg', size: 100, type: 'image/svg+xml' }, []);
    expect(problem).toContain('PNG, JPEG, GIF, and WebP');
  });

  it('rejects oversized images and oversized totals', () => {
    expect(
      validateImageFile({ name: 'big.png', size: MAX_IMAGE_BYTES + 1, type: 'image/png' }, []),
    ).toContain('capped');
    const current: ComposerAttachment[] = [image('a.png', 15 * 1024 * 1024)];
    expect(
      validateImageFile({ name: 'b.png', size: 6 * 1024 * 1024, type: 'image/png' }, current),
    ).toContain('per message');
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
