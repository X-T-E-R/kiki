import { describe, expect, it } from 'vitest';

import {
  classifyResource,
  isKikiComputer,
  isLosslessUtf8Bytes,
  normalizeHostFilePath,
  previewResourceKey,
  resourceActions,
  resourceMutability,
  resourceReadOnlyReason,
  type PreviewEnvironment,
  type PreviewReadState,
  type PreviewResource,
  type ResourceActionId,
} from './previewResource';

describe('previewResource identity keys & normalization', () => {
  it('maps five spellings of one Windows path to a single identity key', () => {
    const cwd = 'C:\\Users\\demo\\project';
    const spellings = [
      'C:\\Users\\demo\\project\\src\\app.ts',
      'c:/users/demo/project/src/app.ts',
      'src/app.ts:42:7',
      'file:///C:/Users/demo/project/src/../src/app.ts#L10-L20',
      '/C:/Users/demo/project/./src/app.ts',
    ];
    const keys = spellings.map((path) =>
      previewResourceKey({ source: { kind: 'host-file', path } }, cwd),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('file:c:/users/demo/project/src/app.ts');
    expect(normalizeHostFilePath('src/app.ts:42', cwd)).toBe('C:/Users/demo/project/src/app.ts');
  });

  it('normalizes POSIX spellings including markdown headings and line citations', () => {
    const cwd = '/workspace/repo';
    const spellings = [
      '/workspace/repo/docs/guide.md',
      'docs/guide.md#install-steps',
      'docs/../docs/./guide.md:12',
      'file:///workspace/repo/docs/guide.md#L4C2',
    ];
    const keys = spellings.map((path) =>
      previewResourceKey({ source: { kind: 'host-file', path } }, cwd),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('file:/workspace/repo/docs/guide.md');
  });

  it('gives a live host file and its session copy distinct keys and mutability', () => {
    const live: PreviewResource = {
      source: { kind: 'host-file', path: '/workspace/notes.md' },
      origin: { path: '/workspace/notes.md', trusted: true },
      type: 'markdown',
    };
    const copy: PreviewResource = {
      source: {
        kind: 'session-copy',
        sessionId: 'sess-1',
        fileId: 'blobref:main:abc',
        sourceId: 'a'.repeat(64),
      },
      origin: { path: '/workspace/notes.md', trusted: true },
      type: 'markdown',
    };
    expect(previewResourceKey(live)).not.toBe(previewResourceKey(copy));
    expect(resourceMutability(live)).toBe('live');
    expect(resourceMutability(copy)).toBe('copy');
    expect(previewResourceKey(copy)).toBe(`attachment:sess-1:${encodeURIComponent('blobref:main:abc')}:${'a'.repeat(64)}`);
  });
});

describe('classifyResource', () => {
  it('handles .ipynb, .csv/.tsv, legacy Office vs OOXML, and .svg', () => {
    expect(classifyResource({ name: 'notebook.ipynb', mime: 'application/x-ipynb+json' })).toBe('text');
    expect(classifyResource({ name: 'metrics.csv', mime: 'text/csv' })).toBe('table');
    expect(classifyResource({ name: 'metrics.tsv', mime: 'text/tab-separated-values' })).toBe('table');
    expect(classifyResource({ name: 'legacy.doc', mime: 'application/msword' })).toBe('unsupported');
    expect(classifyResource({ name: 'legacy.xls', mime: 'application/vnd.ms-excel' })).toBe('unsupported');
    expect(classifyResource({ name: 'legacy.ppt', mime: 'application/vnd.ms-powerpoint' })).toBe('unsupported');
    expect(classifyResource({ name: 'modern.docx' })).toBe('office');
    expect(classifyResource({ name: 'modern.xlsx' })).toBe('office');
    expect(classifyResource({ name: 'modern.pptx' })).toBe('office');
    expect(classifyResource({ name: 'diagram.svg', mime: 'image/svg+xml' })).toBe('image');
    expect(classifyResource({ name: 'report.pdf' })).toBe('pdf');
    expect(classifyResource({ name: 'README.md' })).toBe('markdown');
    expect(classifyResource({ name: 'index.html' })).toBe('html');
    expect(classifyResource({ name: 'clip.mp4' })).toBe('video');
    expect(classifyResource({ name: 'voice.wav' })).toBe('audio');
  });

  it('classifies extension-less files as text only when the name is a known text file name and bytes decode losslessly as UTF-8', () => {
    const utf8Script = new TextEncoder().encode('#!/bin/sh\necho "hello 世界"\n');
    const dockerfileUtf8 = new TextEncoder().encode('FROM node:24\nWORKDIR /app\n');
    const invalidUtf8 = new Uint8Array([0x80, 0xff, 0xfe, 0x41]);
    const elfBinary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

    expect(isLosslessUtf8Bytes(utf8Script)).toBe(true);
    expect(isLosslessUtf8Bytes(invalidUtf8)).toBe(false);
    expect(isLosslessUtf8Bytes(elfBinary)).toBe(false);

    expect(classifyResource({ name: 'Makefile', head: utf8Script })).toBe('text');
    expect(classifyResource({ name: 'Dockerfile', head: dockerfileUtf8 })).toBe('text');
    expect(classifyResource({ name: '.gitignore', head: new TextEncoder().encode('node_modules/\n') })).toBe('text');
    expect(classifyResource({ name: 'Makefile', head: invalidUtf8 })).toBe('unsupported');
    expect(classifyResource({ name: 'Makefile' })).toBe('unsupported');
    expect(classifyResource({ name: 'run-script', head: utf8Script })).toBe('unsupported');
    expect(classifyResource({ name: 'app-binary', head: elfBinary })).toBe('unsupported');
    expect(classifyResource({ name: 'Dockerfile', head: elfBinary })).toBe('unsupported');
  });

  it('prefers the filename extension when declared MIME disagrees', () => {
    expect(classifyResource({ name: 'diagram.svg', mime: 'text/plain' })).toBe('image');
    expect(classifyResource({ name: 'notes.md', mime: 'application/octet-stream' })).toBe('markdown');
    expect(classifyResource({ name: 'legacy.doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('unsupported');
    expect(classifyResource({ name: 'photo.png', mime: 'text/plain' })).toBe('image');
    expect(classifyResource({ name: 'table.csv', mime: 'text/plain' })).toBe('table');
  });
});

describe('isKikiComputer', () => {
  it('returns true only for non-remote desktop and loopback browser connections', () => {
    expect(isKikiComputer({ connectionSource: 'desktop', scopeId: 'local', spaceKey: 'main' })).toBe(true);
    expect(isKikiComputer({ connectionSource: 'manual', config: { url: 'http://127.0.0.1:5177' } })).toBe(true);
    expect(isKikiComputer({ connectionSource: 'stored', config: { url: 'http://localhost:5177' } })).toBe(true);
    expect(isKikiComputer({ connectionSource: 'deep-link', config: { url: 'http://[::1]:5177' } })).toBe(true);
    expect(isKikiComputer({ connectionSource: 'local-detection', config: { url: '' } }, { pageUrl: 'http://127.0.0.1:4173' })).toBe(true);
  });

  it('fails closed for null/undefined, remote scopes, app-shell, web-cookie, non-loopback, and unknown sources', () => {
    expect(isKikiComputer(null)).toBe(false);
    expect(isKikiComputer(undefined)).toBe(false);
    expect(isKikiComputer({ connectionSource: 'desktop', scopeId: 'ssh:prod', spaceKey: 'ssh:prod' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'manual', scopeId: 'direct:peer', config: { url: 'http://127.0.0.1:5177' } })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'remote', scopeId: 'remote:c1', spaceKey: 'remote:c1' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'desktop', spaceKey: 'remote:uuid' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'app-shell', scopeId: 'direct:', config: { url: '' } }, { pageUrl: 'http://127.0.0.1:4173' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'web-cookie', config: { url: '' } }, { pageUrl: 'http://127.0.0.1:4173' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'manual', config: { url: 'https://kiki.example.com' } })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'local-detection', config: { url: '' } }, { pageUrl: 'https://lan.example.com:5177' })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'local-detection', config: { url: '' } })).toBe(false);
    expect(isKikiComputer({ connectionSource: 'future-unknown-source', config: { url: 'http://127.0.0.1:5177' } })).toBe(false);
    expect(isKikiComputer({ scopeId: 'local', spaceKey: 'main' })).toBe(false);
  });
});

describe('resourceActions truth table', () => {
  const hostMarkdown: PreviewResource = {
    source: { kind: 'host-file', path: '/workspace/README.md' },
    origin: { path: '/workspace/README.md', trusted: true },
    type: 'markdown',
    name: 'README.md',
  };
  const copyWithOrigin: PreviewResource = {
    source: {
      kind: 'session-copy',
      sessionId: 'sess-1',
      fileId: 'blobref:main:123',
      sourceId: 'a'.repeat(64),
    },
    origin: { path: '/workspace/README.md', trusted: true },
    type: 'markdown',
    name: 'README.md',
  };
  const copyWithoutOrigin: PreviewResource = {
    source: {
      kind: 'session-copy',
      sessionId: 'sess-1',
      fileId: 'f_upload_0001',
    },
    type: 'markdown',
    name: 'upload.md',
  };
  const httpWebUrl: PreviewResource = {
    source: { kind: 'url', url: 'https://docs.example.com/guide' },
    type: 'html',
    name: 'guide',
  };

  type ResourceKey = 'host-file' | 'copy-with-origin' | 'copy-without-origin' | 'url';
  type CapKey = 'none' | 'reveal-open' | 'write';
  type ReadKey = 'ready' | 'failed';

  const RESOURCES: Record<ResourceKey, PreviewResource> = {
    'host-file': hostMarkdown,
    'copy-with-origin': copyWithOrigin,
    'copy-without-origin': copyWithoutOrigin,
    url: httpWebUrl,
  };

  const CAPABILITIES: Record<CapKey, PreviewEnvironment['capabilities']> = {
    none: {},
    'reveal-open': { reveal: true, open: true },
    write: { reveal: true, open: true, write: true },
  };

  const READ_STATES: Record<ReadKey, PreviewReadState> = {
    ready: { status: 'ready', losslessUtf8: true, truncated: false, readableFromDevice: true, originalReadable: true },
    failed: { status: 'failed', readableFromDevice: false, originalReadable: false, failureReason: 'missing' },
  };

  const EXPECTED: Record<
    ResourceKey,
    Record<'local' | 'remote', Record<CapKey, Record<ReadKey, readonly ResourceActionId[]>>>
  > = {
    'host-file': {
      local: {
        none: {
          ready: ['rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'reload'],
          failed: ['copy-path', 'reload'],
        },
        'reveal-open': {
          ready: ['rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'show-on-this-computer', 'open-with-default-app', 'reload'],
          failed: ['copy-path', 'show-on-this-computer', 'open-with-default-app', 'reload'],
        },
        write: {
          ready: ['rendered-source', 'edit', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'show-on-this-computer', 'open-with-default-app', 'reload'],
          failed: ['copy-path', 'show-on-this-computer', 'open-with-default-app', 'reload'],
        },
      },
      remote: {
        none: {
          ready: ['rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'reload'],
          failed: ['copy-path', 'reload'],
        },
        'reveal-open': {
          ready: ['rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'reload'],
          failed: ['copy-path', 'reload'],
        },
        write: {
          ready: ['rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'reload'],
          failed: ['copy-path', 'reload'],
        },
      },
    },
    'copy-with-origin': {
      local: {
        none: {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path'],
          failed: ['copy-path'],
        },
        'reveal-open': {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'show-on-this-computer', 'open-with-default-app'],
          failed: ['copy-path', 'show-on-this-computer', 'open-with-default-app'],
        },
        write: {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path', 'show-on-this-computer', 'open-with-default-app'],
          failed: ['copy-path', 'show-on-this-computer', 'open-with-default-app'],
        },
      },
      remote: {
        none: {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path'],
          failed: ['copy-path'],
        },
        'reveal-open': {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path'],
          failed: ['copy-path'],
        },
        write: {
          ready: ['open-current-file', 'rendered-source', 'find-in-file', 'download', 'add-to-chat', 'copy-content', 'copy-path'],
          failed: ['copy-path'],
        },
      },
    },
    'copy-without-origin': {
      local: {
        none: {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
        'reveal-open': {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
        write: {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
      },
      remote: {
        none: {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
        'reveal-open': {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
        write: {
          ready: ['rendered-source', 'find-in-file', 'download', 'copy-content'],
          failed: [],
        },
      },
    },
    url: {
      local: {
        none: {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
        'reveal-open': {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
        write: {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
      },
      remote: {
        none: {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
        'reveal-open': {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
        write: {
          ready: ['rendered-source', 'download', 'copy-content', 'open-in-browser', 'reload'],
          failed: ['open-in-browser', 'reload'],
        },
      },
    },
  };

  for (const resourceKey of Object.keys(RESOURCES) as ResourceKey[]) {
    for (const computerKey of ['local', 'remote'] as const) {
      for (const capKey of Object.keys(CAPABILITIES) as CapKey[]) {
        for (const readKey of Object.keys(READ_STATES) as ReadKey[]) {
          it(`${resourceKey} × ${computerKey} × ${capKey} × ${readKey}`, () => {
            const environment: PreviewEnvironment = {
              isKikiComputer: computerKey === 'local',
              hasSession: true,
              capabilities: CAPABILITIES[capKey],
            };
            const actions = resourceActions(RESOURCES[resourceKey], environment, READ_STATES[readKey]);
            expect(actions.map((action) => action.id)).toEqual(
              EXPECTED[resourceKey][computerKey][capKey][readKey],
            );
          });
        }
      }
    }
  }

  it('uses distinct copy/live labels and reports read-only reason for non-UTF-8 text files', () => {
    const localWriteEnv: PreviewEnvironment = {
      isKikiComputer: true,
      hasSession: true,
      capabilities: { reveal: true, open: true, write: true },
    };
    const hostActions = resourceActions(hostMarkdown, localWriteEnv, READ_STATES.ready);
    expect(hostActions.find((a) => a.id === 'open-with-default-app')).toEqual({
      id: 'open-with-default-app',
      zh: '以默认程序打开',
      en: 'Open with default app',
    });

    const copyActions = resourceActions(copyWithOrigin, localWriteEnv, READ_STATES.ready);
    expect(copyActions.find((a) => a.id === 'open-with-default-app')).toEqual({
      id: 'open-with-default-app',
      zh: '打开原文件',
      en: 'Open original file',
    });

    const gbkText: PreviewResource = {
      source: { kind: 'host-file', path: '/workspace/legacy.txt' },
      origin: { path: '/workspace/legacy.txt', trusted: true },
      type: 'text',
      name: 'legacy.txt',
    };
    const nonUtf8Read: PreviewReadState = {
      status: 'ready',
      losslessUtf8: false,
      truncated: false,
      readableFromDevice: true,
    };
    expect(resourceActions(gbkText, localWriteEnv, nonUtf8Read).some((a) => a.id === 'edit')).toBe(false);
    expect(resourceReadOnlyReason(gbkText, localWriteEnv, nonUtf8Read)).toEqual({
      zh: '只读：不是 UTF-8 文本',
      en: 'Read-only: not UTF-8 text',
    });

    const truncatedRead: PreviewReadState = {
      status: 'ready',
      losslessUtf8: true,
      truncated: true,
      readableFromDevice: true,
    };
    const truncatedActions = resourceActions(gbkText, localWriteEnv, truncatedRead).map((a) => a.id);
    expect(truncatedActions).not.toContain('edit');
    expect(truncatedActions).not.toContain('copy-content');
  });
});
