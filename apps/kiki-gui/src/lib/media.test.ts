import { describe, expect, it } from 'vitest';

import type { Message } from '@moonshot-ai/protocol';

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

  it('keeps upload-id sources as non-renderable refs', () => {
    const content: Message['content'] = [
      { type: 'image', source: { kind: 'file', file_id: 'upl_1' } },
    ];
    expect(mediaFromContentParts(content)).toEqual([{ kind: 'image', fileId: 'upl_1' }]);
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

  it('returns undefined for plain strings, objects, and text-only arrays', () => {
    expect(extractToolOutputMedia('plain')).toBeUndefined();
    expect(extractToolOutputMedia({ kind: 'text', text: 'x' })).toBeUndefined();
    expect(extractToolOutputMedia([{ type: 'text', text: 'only text' }])).toBeUndefined();
    expect(extractToolOutputMedia([{ a: 1 }, { b: 2 }])).toBeUndefined();
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
