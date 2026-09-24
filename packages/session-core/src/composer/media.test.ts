import { describe, expect, it } from 'vitest';

import type { Message } from '@kiki/protocol';

import {
  FILE_LINK_SENTINEL,
  extOf,
  extractToolOutputMedia,
  formatBytes,
  isAppRouteHref,
  joinPath,
  mediaFromContentParts,
  previewKindOf,
  resolveFileHref,
  resolveFileReference,
  unwrapFileLinkTarget,
  wrapFileLinkTarget,
} from './media';

describe('mediaFromContentParts', () => {
  it('rebuilds a data: URL for inline base64 images', () => {
    const content: Message['content'] = [
      { type: 'text', text: 'look' },
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ];
    expect(mediaFromContentParts(content)).toEqual([
      { kind: 'image', url: 'data:image/png;base64,aGVsbG8=', mime: 'image/png' },
    ]);
  });

  it('passes url sources through (snapshot projects user images as data: URLs)', () => {
    const content: Message['content'] = [
      { type: 'image', source: { kind: 'url', url: 'data:image/jpeg;base64,/9j/' } },
      { type: 'video', source: { kind: 'url', url: 'https://example.test/clip.mp4' } },
    ];
    expect(mediaFromContentParts(content)).toEqual([
      { kind: 'image', url: 'data:image/jpeg;base64,/9j/', mime: 'image/jpeg' },
      { kind: 'video', url: 'https://example.test/clip.mp4', mime: undefined },
    ]);
  });

  it('keeps upload and session-owned sources as non-renderable refs', () => {
    const content: Message['content'] = [
      { type: 'image', source: { kind: 'file', file_id: 'upl_1' } },
      { type: 'video', source: { kind: 'session_media', file_id: 'media_1' } },
    ];
    expect(mediaFromContentParts(content)).toEqual([
      { kind: 'image', fileId: 'upl_1' },
      { kind: 'video', fileId: 'media_1' },
    ]);
  });

  it('keeps file parts as chip metadata', () => {
    const content: Message['content'] = [
      { type: 'file', file_id: 'upl_2', name: 'report.pdf', media_type: 'application/pdf', size: 2048 },
    ];
    expect(mediaFromContentParts(content)).toEqual([
      { kind: 'file', fileId: 'upl_2', name: 'report.pdf', mime: 'application/pdf', size: 2048 },
    ]);
  });

  it('returns an empty list for text-only content', () => {
    expect(mediaFromContentParts([{ type: 'text', text: 'hi' }])).toEqual([]);
  });
});

describe('extractToolOutputMedia', () => {
  it('extracts engine image_url parts and their <image path> wrapper', () => {
    const output = [
      { type: 'text', text: '<image path="/work/shots/home.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: '</image>' },
    ];
    expect(extractToolOutputMedia(output)).toEqual({
      text: '',
      media: [
        {
          kind: 'image',
          url: 'data:image/png;base64,AAA',
          path: '/work/shots/home.png',
          mime: 'image/png',
        },
      ],
    });
  });

  it('keeps surrounding prose text alongside the media', () => {
    const output = [
      { type: 'text', text: 'Here is the render.' },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,BBB' } },
    ];
    const extracted = extractToolOutputMedia(output);
    expect(extracted?.text).toBe('Here is the render.');
    expect(extracted?.media).toEqual([
      { kind: 'image', url: 'data:image/webp;base64,BBB', path: undefined, mime: 'image/webp' },
    ]);
  });

  it('preserves the exact persisted media hash alongside the original display path', () => {
    const output = [
      { type: 'text', text: '<image path="C:\\work\\shots\\home.png">' },
      { type: 'image_url', imageUrl: { url: `blobref:image/png;${'a'.repeat(64)}` } },
      { type: 'text', text: '</image>' },
    ];
    expect(extractToolOutputMedia(output)).toEqual({
      text: '',
      media: [{ kind: 'image', url: undefined, path: 'C:\\work\\shots\\home.png', mime: 'image/png', blobHash: 'a'.repeat(64) }],
    });
  });

  it('associates video paths without leaking wrapper tags and keeps playable videos unchanged', () => {
    expect(extractToolOutputMedia([
      { type: 'text', text: '<video path="/work/clip.mp4">' },
      { type: 'video_url', videoUrl: { url: 'ms://uploaded-id' } },
      { type: 'text', text: '</video>' },
      { type: 'text', text: '<video path="/work/inline.mp4">' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAA' } },
      { type: 'text', text: '</video>' },
    ])).toEqual({
      text: '',
      media: [
        { kind: 'video', url: undefined, path: '/work/clip.mp4', mime: undefined },
        { kind: 'video', url: 'data:video/mp4;base64,AAA', path: '/work/inline.mp4', mime: 'video/mp4' },
      ],
    });
  });

  it('does not attach an image path to unrelated media or pass a private URL to the browser', () => {
    expect(extractToolOutputMedia([
      { type: 'text', text: '<image path="/work/one.png">' },
      { type: 'video_url', videoUrl: { url: 'ms://video-id' } },
      { type: 'text', text: '</image>' },
      { type: 'image_url', imageUrl: { url: `blobref:image/png;${'b'.repeat(64)}` } },
    ])).toEqual({
      text: '',
      media: [
        { kind: 'video', url: undefined, path: undefined, mime: undefined },
        { kind: 'image', url: undefined, path: undefined, mime: 'image/png', blobHash: 'b'.repeat(64) },
      ],
    });
  });

  it('preserves video blob bytes and never substitutes the host path for malformed blob references', () => {
    expect(extractToolOutputMedia([
      { type: 'text', text: '<video path="/work/crop.mp4">' },
      { type: 'video_url', videoUrl: { url: `blobref:video/mp4;${'c'.repeat(64)}` } },
      { type: 'text', text: '</video>' },
      { type: 'text', text: '<image path="/work/original.png">' },
      { type: 'image_url', imageUrl: { url: 'blobref:image/png;not-a-hash' } },
    ])).toEqual({
      text: '',
      media: [
        { kind: 'video', url: undefined, path: '/work/crop.mp4', mime: 'video/mp4', blobHash: 'c'.repeat(64) },
        { kind: 'image', url: undefined, path: undefined, name: '/work/original.png', mime: undefined },
      ],
    });
  });

  it('returns undefined for plain strings, objects, and text-only arrays', () => {
    expect(extractToolOutputMedia('plain')).toBeUndefined();
    expect(extractToolOutputMedia({ kind: 'text', text: 'x' })).toBeUndefined();
    expect(extractToolOutputMedia([{ type: 'text', text: 'only text' }])).toBeUndefined();
    expect(extractToolOutputMedia([{ a: 1 }, { b: 2 }])).toBeUndefined();
  });
});

describe('file reference positions', () => {
  it.each([
    ['taskService.ts:1063', '/work/taskService.ts', 1063, undefined],
    ['src/taskService.ts:1063:7', '/work/src/taskService.ts', 1063, 7],
    ['C:\\work\\taskService.ts:1063:7', 'C:\\work\\taskService.ts', 1063, 7],
    ['/C:/work/taskService.ts:1063', 'C:/work/taskService.ts', 1063, undefined],
    ['file:///C:/work/%E4%B8%AD%20a.ts:12:3', 'C:/work/中 a.ts', 12, 3],
    ['file:///work/app.ts#L12C3', '/work/app.ts', 12, 3],
    ['src/中 a.ts:2', '/work/src/中 a.ts', 2, undefined],
    ['src/a%20b.ts:2', '/work/src/a b.ts', 2, undefined],
  ])('separates %s', (href, path, line, column) => {
    expect(resolveFileReference(href, '/work')).toEqual({ path, line, column });
    expect(resolveFileHref(href, '/work')).toBe(path);
    if (!href.startsWith('/') || href.startsWith('/C:')) expect(wrapFileLinkTarget(href)).toBeDefined();
  });

  it('normalizes only explicit Windows drive roots and preserves filename punctuation', () => {
    for (const path of ['/C:/work/中 dir', '/C:\\work\\dir']) {
      expect(resolveFileHref(path, undefined)).toBe(path.slice(1));
    }
    for (const path of ['/var/a:b.ts', '/work/a.ts:notes', '/C:relative', '/work/a.ts:0']) {
      expect(resolveFileReference(path, undefined)).toEqual({ path });
    }
    expect(resolveFileReference('file:///work/a.ts%3A12', undefined)).toEqual({ path: '/work/a.ts:12' });
    expect(resolveFileReference('/work/a.ts%2312', undefined)).toEqual({ path: '/work/a.ts#12' });
  });

  it.each(['https://example.test/a.ts:12', '//example.test/a.ts:12', 'mailto:a@example.test', 'ms://file/a.ts:12', '/s/session/file.ts:12', '/settings/general', '/settings?tab=general', '/usage#today', '#L12'])('does not capture %s', (href) => {
    expect(resolveFileReference(href, '/work')).toBeUndefined();
  });
});

describe('resolveFileHref', () => {
  it('decodes file:// URLs across platforms', () => {
    expect(resolveFileHref('file:///C:/work/a%20b.png', undefined)).toBe('C:/work/a b.png');
    expect(resolveFileHref('file:///home/u/x.ts', undefined)).toBe('/home/u/x.ts');
  });

  it('accepts absolute host paths without a cwd', () => {
    expect(resolveFileHref('/home/u/x.ts', undefined)).toBe('/home/u/x.ts');
    expect(resolveFileHref('C:\\work\\x.ts', undefined)).toBe('C:\\work\\x.ts');
    expect(resolveFileHref('D:/work/x.ts', '/elsewhere')).toBe('D:/work/x.ts');
  });

  it('leaves external URLs, app routes, and anchors alone', () => {
    expect(resolveFileHref('https://example.test/x.png', '/w')).toBeUndefined();
    expect(resolveFileHref('ms://file/upl_1', '/w')).toBeUndefined();
    expect(resolveFileHref('/usage', '/w')).toBeUndefined();
    expect(resolveFileHref('/s/sess_1', '/w')).toBeUndefined();
    expect(resolveFileHref('/new', '/w')).toBeUndefined();
    expect(resolveFileHref('#section', '/w')).toBeUndefined();
  });

  it('anchors relative file references at the session cwd', () => {
    expect(resolveFileHref('src/app.ts', '/work/app')).toBe('/work/app/src/app.ts');
    expect(resolveFileHref('./out/shot.png', 'C:/work')).toBe('C:/work/out/shot.png');
    expect(resolveFileHref('../shared/util.py', '/work/app')).toBe('/work/shared/util.py');
  });

  it('refuses relative references without a cwd or without a file shape', () => {
    expect(resolveFileHref('src/app.ts', undefined)).toBeUndefined();
    expect(resolveFileHref('README', '/work')).toBeUndefined();
  });
});

describe('joinPath', () => {
  it('resolves . and .. segments on both path styles', () => {
    expect(joinPath('/work/app', './src/../lib/x.ts')).toBe('/work/app/lib/x.ts');
    expect(joinPath('C:/work', 'a/b/../c.png')).toBe('C:/work/a/c.png');
    expect(joinPath('/work/', 'x.ts')).toBe('/work/x.ts');
  });
});

describe('isAppRouteHref', () => {
  it('matches the known app routes only', () => {
    expect(isAppRouteHref('/')).toBe(true);
    expect(isAppRouteHref('/settings/general')).toBe(true);
    expect(isAppRouteHref('/work/file.ts')).toBe(false);
  });
});

describe('previewKindOf / extOf', () => {
  it('routes by extension', () => {
    expect(previewKindOf('/x/shot.PNG')).toBe('image');
    expect(previewKindOf('/x/notes.md')).toBe('markdown');
    expect(previewKindOf('C:/x/app.tsx')).toBe('text');
    expect(previewKindOf('/x/Makefile')).toBe('text');
    expect(previewKindOf('/x/archive.zip')).toBe('binary');
    expect(previewKindOf('/x/no-extension')).toBe('text');
  });

  it('extracts the basename extension case-insensitively', () => {
    expect(extOf('C:\\a\\b.Ts')).toBe('ts');
    expect(extOf('/a/.gitignore')).toBe('gitignore');
    expect(extOf('/a/noext')).toBe('');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('file link sentinel (markdown sanitize bypass)', () => {
  it('wraps local-file targets and unwraps them verbatim', () => {
    for (const url of [
      './config/app.toml',
      'src/app.ts',
      '../shared/util.py',
      'C:/work/x.ts',
      'file:///C:/work/y.png',
    ]) {
      const wrapped = wrapFileLinkTarget(url);
      expect(wrapped?.startsWith(FILE_LINK_SENTINEL)).toBe(true);
      expect(unwrapFileLinkTarget(wrapped!)).toBe(url);
    }
  });

  it('leaves external URLs, posix absolutes, and anchors alone', () => {
    for (const url of ['https://example.test/x', '/home/u/x.ts', '#section', 'mailto:a@example.test']) {
      expect(wrapFileLinkTarget(url)).toBeUndefined();
    }
    expect(unwrapFileLinkTarget('/usage')).toBeUndefined();
  });

  it('unwraps resolve through resolveFileHref with the session cwd', () => {
    const wrapped = wrapFileLinkTarget('./config/app.toml')!;
    expect(resolveFileHref(unwrapFileLinkTarget(wrapped)!, '/work/app')).toBe('/work/app/config/app.toml');
  });
});
