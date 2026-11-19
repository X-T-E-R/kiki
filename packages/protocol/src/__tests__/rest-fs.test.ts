import { describe, expect, it } from 'vitest';

import {
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
  type DeleteFileResponse,
  type UploadFileResponse,
} from '../rest/file';
import {
  fsDownloadParamsSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsSuggestRequestSchema,
  fsSuggestResponseSchema,
} from '../rest/fs';
import {
  fsBrowseEntrySchema,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '../rest/fsBrowse';

describe('files REST schemas (/api/files)', () => {
  it('round-trips FileMeta and enforces file_id & false-positive delete guards', () => {
    const uploaded: UploadFileResponse = {
      id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
      name: 'note.txt',
      media_type: 'text/plain',
      size: 12,
      created_at: '2026-06-04T10:00:00.000Z',
      session_id: 'session-owner',
    };
    expect(uploadFileResponseSchema.parse(uploaded)).toEqual(uploaded);

    for (const schema of [getFileParamSchema, deleteFileParamSchema]) {
      expect(schema.parse({ file_id: 'f_abc' }).file_id).toBe('f_abc');
      expect(schema.safeParse({ file_id: '' }).success).toBe(false);
    }

    const ok: DeleteFileResponse = { deleted: true };
    expect(deleteFileResponseSchema.parse(ok)).toEqual({ deleted: true });
    expect(deleteFileResponseSchema.safeParse({ deleted: false }).success).toBe(false);
  });
});

describe('fsBrowse & fsHome REST schemas', () => {
  it('validates fsBrowseQuerySchema, dir-only entries, root parents, and recent_roots', () => {
    expect(fsBrowseQuerySchema.parse({})).toEqual({});
    expect(fsBrowseQuerySchema.parse({ path: '/Users/foo' })).toEqual({ path: '/Users/foo' });
    expect(fsBrowseQuerySchema.safeParse({ path: '' }).success).toBe(false);

    const entry = { name: 'src', path: '/Users/foo/code/src', is_dir: true as const };
    expect(fsBrowseEntrySchema.parse(entry)).toEqual(entry);
    expect(fsBrowseEntrySchema.safeParse({ name: 'README.md', path: '/Users/foo/code/README.md', is_dir: false }).success)
      .toBe(false);

    expect(
      fsBrowseResponseSchema.parse({
        path: '/Users/foo/code',
        parent: '/Users/foo',
        entries: [{ name: 'kimi-code', path: '/Users/foo/code/kimi-code', is_dir: true as const }],
      }).entries,
    ).toHaveLength(1);
    expect(fsBrowseResponseSchema.parse({ path: '/', parent: null, entries: [] }).parent).toBeNull();

    expect(fsHomeResponseSchema.parse({ home: '/Users/foo', recent_roots: [] }))
      .toEqual({ home: '/Users/foo', recent_roots: [] });
    expect(fsHomeResponseSchema.parse({ home: '/Users/foo', recent_roots: ['/Users/foo/code/kimi-code', '/Users/foo/code/other'] }).recent_roots)
      .toHaveLength(2);
  });
});

describe('fs list / read / stat / download / mkdir schemas', () => {
  it.each([
    [
      'fsListRequest defaults',
      fsListRequestSchema,
      {},
      { path: '.', depth: 1, limit: 200, show_hidden: false, follow_gitignore: true, sort: 'type_first', include_git_status: false },
    ],
    [
      'fsListRequest populated',
      fsListRequestSchema,
      { path: 'src', depth: 3, limit: 500, show_hidden: true, follow_gitignore: false, exclude_globs: ['**/node_modules/**'], sort: 'mtime_desc' as const, include_git_status: true },
      { path: 'src', depth: 3, limit: 500, show_hidden: true, follow_gitignore: false, exclude_globs: ['**/node_modules/**'], sort: 'mtime_desc', include_git_status: true },
    ],
    [
      'fsReadRequest defaults',
      fsReadRequestSchema,
      { path: 'a.ts' },
      { path: 'a.ts', offset: 0, length: 1_048_576, encoding: 'auto' },
    ],
    [
      'fsListManyRequest defaults',
      fsListManyRequestSchema,
      { paths: ['a', 'b'] },
      { paths: ['a', 'b'], depth: 1, limit: 200, show_hidden: false, follow_gitignore: true, sort: 'type_first', include_git_status: false },
    ],
    [
      'fsStatRequest',
      fsStatRequestSchema,
      { path: 'a' },
      { path: 'a' },
    ],
    [
      'fsDownloadParams minimal',
      fsDownloadParamsSchema,
      { path: 'a.txt' },
      { path: 'a.txt' },
    ],
    [
      'fsDownloadParams range + etag',
      fsDownloadParamsSchema,
      { path: 'big.bin', range: 'bytes=0-65535', if_none_match: 'cafebabe' },
      { path: 'big.bin', range: 'bytes=0-65535', if_none_match: 'cafebabe' },
    ],
    [
      'fsMkdirRequest defaults',
      fsMkdirRequestSchema,
      { path: 'a' },
      { path: 'a', recursive: false },
    ],
    [
      'fsMkdirRequest recursive',
      fsMkdirRequestSchema,
      { path: 'a/b', recursive: true },
      { path: 'a/b', recursive: true },
    ],
  ] as const)('parses %s', (_label, schema, input, expected) => {
    expect((schema as { parse: (v: unknown) => unknown }).parse(input)).toEqual(expected);
  });

  it.each([
    ['fsListRequest depth > 10', fsListRequestSchema, { depth: 11 }],
    ['fsListRequest limit > 1000', fsListRequestSchema, { limit: 1001 }],
    ['fsReadRequest length > 10MB', fsReadRequestSchema, { path: 'a', length: 10_485_761 }],
    ['fsReadRequest empty path', fsReadRequestSchema, { path: '' }],
    ['fsReadRequest negative offset', fsReadRequestSchema, { path: 'a', offset: -1 }],
    ['fsListManyRequest empty paths', fsListManyRequestSchema, { paths: [] }],
    ['fsListManyRequest > 100 paths', fsListManyRequestSchema, { paths: Array.from({ length: 101 }, (_, i) => `p${i}`) }],
    ['fsStatRequest empty path', fsStatRequestSchema, { path: '' }],
    ['fsStatManyRequest empty paths', fsStatManyRequestSchema, { paths: [] }],
    ['fsStatManyRequest > 1000 paths', fsStatManyRequestSchema, { paths: Array.from({ length: 1001 }, (_, i) => `p${i}`) }],
    ['fsDownloadParams empty path', fsDownloadParamsSchema, { path: '' }],
    ['fsMkdirRequest empty path', fsMkdirRequestSchema, { path: '' }],
    ['fsMkdirRequest missing path', fsMkdirRequestSchema, {}],
  ] as const)('rejects %s', (_label, schema, input) => {
    expect((schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(input).success).toBe(false);
  });

  it('round-trips fs responses and caps fsStatMany at exactly 1000 paths', () => {
    expect(fsListResponseSchema.parse({ items: [], truncated: false })).toEqual({ items: [], truncated: false });
    const listWithChildren = {
      items: [{ path: 'src', name: 'src', kind: 'directory' as const, modified_at: '2026-06-04T10:00:00.000Z', child_count: 2 }],
      children_by_path: { src: [{ path: 'src/index.ts', name: 'index.ts', kind: 'file' as const, size: 100, modified_at: '2026-06-04T10:00:00.000Z' }] },
      truncated: false,
    };
    expect(fsListResponseSchema.parse(listWithChildren)).toEqual(listWithChildren);

    const textRead = { path: 'a.ts', content: 'hello', encoding: 'utf-8' as const, size: 5, truncated: false, etag: 'deadbeef', mime: 'text/typescript', language_id: 'typescript', line_count: 1, is_binary: false };
    const binRead = { path: 'a.png', content: 'iVBORw0KGgo=', encoding: 'base64' as const, size: 9, truncated: false, etag: 'cafebabe', mime: 'image/png', is_binary: true };
    expect(fsReadResponseSchema.parse(textRead)).toEqual(textRead);
    expect(fsReadResponseSchema.parse(binRead)).toEqual(binRead);

    const listManyResp = {
      results: { src: [{ path: 'src/index.ts', name: 'index.ts', kind: 'file' as const, size: 100, modified_at: '2026-06-04T10:00:00.000Z' }] },
      partial_errors: { 'does/not/exist': { code: 40409, msg: 'fs.path_not_found' } },
    };
    expect(fsListManyResponseSchema.parse(listManyResp)).toEqual(listManyResp);
    expect(fsStatManyRequestSchema.safeParse({ paths: Array.from({ length: 1000 }, (_, i) => `p${i}`) }).success).toBe(true);
    expect(
      fsStatManyResponseSchema.parse({
        entries: {
          present: { path: 'present', name: 'present', kind: 'file', modified_at: '2026-06-04T10:00:00.000Z' },
          missing: null,
        },
      }).entries['missing'],
    ).toBeNull();

    const mkdirEntry = { path: 'a', name: 'a', kind: 'directory' as const, modified_at: '2026-06-16T08:00:00.000Z', etag: 'deadbeef' };
    expect(fsMkdirResponseSchema.parse(mkdirEntry)).toEqual(mkdirEntry);
  });
});

describe('fs search / suggest / grep / git_status schemas', () => {
  it('validates search and suggest requests and responses', () => {
    expect(fsSearchRequestSchema.parse({ query: 'Button' })).toEqual({ query: 'Button', limit: 50, follow_gitignore: true });
    expect(fsSearchRequestSchema.safeParse({ query: '' }).success).toBe(true);
    expect(fsSearchRequestSchema.safeParse({ query: 'a', limit: 200 }).success).toBe(true);
    expect(fsSearchRequestSchema.safeParse({ query: 'a', limit: 201 }).success).toBe(false);
    const searchPopulated = { query: 'a', limit: 100, include_globs: ['**/*.ts'], exclude_globs: ['**/node_modules/**'], follow_gitignore: false };
    expect(fsSearchRequestSchema.parse(searchPopulated)).toEqual(searchPopulated);
    expect(fsSearchResponseSchema.parse({ items: [], truncated: false, sort_scope: 'page' }))
      .toEqual({ items: [], truncated: false, sort_scope: 'page' });
    const searchHitResp = {
      items: [{ path: 'src/Button.tsx', name: 'Button.tsx', kind: 'file' as const, score: 0.9, match_positions: [4, 5, 6, 7, 8, 9] }],
      truncated: true,
      sort_scope: 'page' as const,
    };
    expect(fsSearchResponseSchema.parse(searchHitResp)).toEqual(searchHitResp);

    expect(fsSuggestRequestSchema.parse({ query: 'Button' }))
      .toEqual({ query: 'Button', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(fsSuggestRequestSchema.safeParse({ query: '' }).success).toBe(true);
    expect(fsSuggestRequestSchema.safeParse({ query: 'a', limit: 200 }).success).toBe(true);
    expect(fsSuggestRequestSchema.safeParse({ query: 'a', limit: 201 }).success).toBe(false);
    const suggestPopulated = { query: 'apps/de', limit: 100, follow_gitignore: false, show_hidden: true, include_globs: ['**/*.ts'], exclude_globs: ['**/node_modules/**'] };
    expect(fsSuggestRequestSchema.parse(suggestPopulated)).toEqual(suggestPopulated);
    expect(fsSuggestResponseSchema.parse({ items: [], truncated: false })).toEqual({ items: [], truncated: false });
    const suggestHitResp = {
      items: [{ path: 'apps/desktop', name: 'desktop', kind: 'directory' as const, score: 0.9, match_positions: [5, 6] }],
      truncated: true,
    };
    expect(fsSuggestResponseSchema.parse(suggestHitResp)).toEqual(suggestHitResp);
  });

  it('validates grep and git_status requests and responses', () => {
    expect(fsGrepRequestSchema.parse({ pattern: 'hello' })).toEqual({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 2,
    });
    expect(fsGrepRequestSchema.parse({ pattern: 'foo|bar', regex: true }).regex).toBe(true);
    expect(fsGrepRequestSchema.safeParse({ pattern: '' }).success).toBe(false);
    expect(fsGrepRequestSchema.safeParse({ pattern: 'a', context_lines: 11 }).success).toBe(false);

    expect(fsGrepResponseSchema.parse({ files: [], files_scanned: 0, truncated: false, elapsed_ms: 12 }))
      .toEqual({ files: [], files_scanned: 0, truncated: false, elapsed_ms: 12 });
    const grepPopulated = {
      files: [{ path: 'src/index.ts', matches: [{ line: 1, col: 1, text: 'console.log("hello");', before: [], after: [] }] }],
      files_scanned: 42,
      truncated: false,
      elapsed_ms: 87,
    };
    expect(fsGrepResponseSchema.parse(grepPopulated)).toEqual(grepPopulated);

    expect(fsGitStatusRequestSchema.parse({})).toEqual({});
    expect(fsGitStatusRequestSchema.parse({ paths: ['a', 'b'] })).toEqual({ paths: ['a', 'b'] });
    expect(fsGitStatusRequestSchema.safeParse({ paths: [''] }).success).toBe(false);

    const cleanTree = { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
    const dirtyTree = {
      branch: 'feat/web',
      ahead: 2,
      behind: 1,
      entries: { 'src/index.ts': 'modified' as const, 'src/new.ts': 'untracked' as const, 'src/old.ts': 'deleted' as const },
      additions: 42,
      deletions: 7,
      pullRequest: { number: 625, state: 'open' as const, url: 'https://github.com/MoonshotAI/kimi-code/pull/625' },
    };
    expect(fsGitStatusResponseSchema.parse(cleanTree)).toEqual(cleanTree);
    expect(fsGitStatusResponseSchema.parse(dirtyTree)).toEqual(dirtyTree);
    expect(fsGitStatusResponseSchema.parse({ ...cleanTree, branch: '' }).branch).toBe('');
  });
});
