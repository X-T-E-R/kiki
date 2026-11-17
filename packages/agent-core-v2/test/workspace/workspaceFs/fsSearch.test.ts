import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workspacePathInventory } from '#/os/backends/node-local/workspacePathInventory';
import { executeWorkspaceTrigram } from '#/os/backends/node-local/workspaceTrigramStore';
import { requiredGrepLiteral } from '#/os/backends/node-local/workspaceTrigramIndex';

import { readSearchCursor, writeSearchCursor } from '#/workspace/workspaceFs/internal/searchCursor';

import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  matchesAnyGlob,
  rgPath,
  stripTrailingNewline,
} from '#/workspace/workspaceFs/internal/fsSearch';

describe('computeFuzzyScore', () => {
  it('returns 0 for an empty query', () => {
    expect(computeFuzzyScore('anything', '')).toBe(0);
  });

  it('returns 0 when the query is not a subsequence', () => {
    expect(computeFuzzyScore('abc', 'az')).toBe(0);
  });

  it('returns 1 for a subsequence match and 0 otherwise', () => {
    expect(computeFuzzyScore('foo-bar', 'foo')).toBe(1);
    expect(computeFuzzyScore('bar-foo', 'foo')).toBe(1);
    expect(computeFuzzyScore('abc', 'xyz')).toBe(0);
  });
});

describe('computeMatchPositions', () => {
  it('returns the matched character indices', () => {
    expect(computeMatchPositions('src/foo.ts', 'foo')).toEqual([4, 5, 6]);
  });

  it('returns empty when query does not match in order', () => {
    expect(computeMatchPositions('abc', 'ca')).toEqual([]);
  });
});

describe('matchesAnyGlob', () => {
  it('matches a single-segment wildcard', () => {
    expect(matchesAnyGlob('src/a.ts', ['*.ts'])).toBe(false);
    expect(matchesAnyGlob('a.ts', ['*.ts'])).toBe(true);
  });

  it('matches a recursive wildcard', () => {
    expect(matchesAnyGlob('src/a.ts', ['**/*.ts'])).toBe(true);
    expect(matchesAnyGlob('src/a.js', ['**/*.ts'])).toBe(false);
  });
});

describe('compileGrepPattern', () => {
  it('treats the pattern as fixed text when regex is false', () => {
    const re = compileGrepPattern({
      pattern: 'a.b',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('aXb')).toBe(false);
    expect(re.test('a.b')).toBe(true);
  });

  it('honors case-insensitive matching', () => {
    const re = compileGrepPattern({
      pattern: 'foo',
      regex: false,
      case_sensitive: false,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('FOO')).toBe(true);
  });
});

describe('stripTrailingNewline', () => {
  it('strips a trailing LF', () => {
    expect(stripTrailingNewline('a\n')).toBe('a');
  });

  it('strips a trailing CRLF', () => {
    expect(stripTrailingNewline('a\r\n')).toBe('a');
  });

  it('leaves other text untouched', () => {
    expect(stripTrailingNewline('a\nb')).toBe('a\nb');
  });
});

describe('rgPath', () => {
  it('returns the text field', () => {
    expect(rgPath({ text: 'src/a.ts' })).toBe('src/a.ts');
  });

  it('strips a leading ./', () => {
    expect(rgPath({ text: './src/a.ts' })).toBe('src/a.ts');
  });

  it('decodes the bytes field as base64', () => {
    expect(rgPath({ bytes: Buffer.from('src/a.ts', 'utf-8').toString('base64') })).toBe(
      'src/a.ts',
    );
  });

  it('returns undefined for missing input', () => {
    expect(rgPath(undefined)).toBeUndefined();
  });
});


describe('search cursor paths', () => {
  it.each(['a:b', 'a\\b'])('preserves POSIX %s and rejects Windows special characters', (path) => {
    const stack = [{ path: '', offset: 1 }, { path, offset: 0 }];
    const cursor = writeSearchCursor(stack, 'conditions')!;
    expect(readSearchCursor(cursor, 'conditions', '/')).toEqual(stack);
    expect(() => readSearchCursor(cursor, 'conditions', '\\')).toThrow('invalid or changed file search cursor');
  });

  it.each(['../outside', '/outside', 'a/../outside', '.git'])('rejects malformed or metadata frame %s', (path) => {
    const cursor = Buffer.from(JSON.stringify({ version: 2, binding: 'conditions', stack: [{ path: '', offset: 1 }, { path, offset: 0 }] })).toString('base64url');
    expect(() => readSearchCursor(cursor, 'conditions', '/')).toThrow('invalid or changed file search cursor');
  });
});

describe('local workspace search indexes', () => {
  it('honors nested ignore rules, sensitive paths, VCS metadata and inventory caps', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp', 'path-inventory-'));
    try {
      for (const dir of ['src', 'ignored', '.git', 'empty', '.aws']) await mkdir(join(root, dir));
      await Promise.all([
        writeFile(join(root, '.gitignore'), 'ignored/\n*.log\n'),
        writeFile(join(root, 'src', '.ignore'), '*.ts\n!keep.ts\n'),
        writeFile(join(root, 'src', '.rgignore'), 'extra.txt\n'),
        ...['src/drop.ts', 'src/keep.ts', 'src/extra.txt', 'src/visible.txt', 'src/trace.log', 'ignored/file.ts', '.git/config', '.env', '.env.example', '.aws/credentials'].map(path => writeFile(join(root, path), 'neutral')),
      ]);
      const inventory = workspacePathInventory(root, 250_000);
      expect(inventory.overflow).toBe(false);
      const files = inventory.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
      expect(files).toContain('src/keep.ts');
      expect(files).toContain('src/visible.txt');
      expect(files).toContain('.env.example');
      for (const hidden of ['src/drop.ts', 'src/extra.txt', 'src/trace.log', 'ignored/file.ts', '.git/config']) expect(files).not.toContain(hidden);
      expect(inventory.entries.find(entry => entry.path === '.env')).toMatchObject({ path: '.env', sensitive: true });
      expect(inventory.entries.find(entry => entry.path === '.aws/credentials')).toMatchObject({ path: '.aws/credentials', sensitive: true });
      const searchableFiles = inventory.entries.filter(entry => entry.kind === 'file' && !entry.sensitive).map(entry => entry.path);
      for (const secret of ['.env', '.aws/credentials']) expect(searchableFiles).not.toContain(secret);
      expect(inventory.entries).toContainEqual(expect.objectContaining({ path: 'empty', kind: 'directory' }));
      expect(workspacePathInventory(root, 2)).toEqual({ entries: [], overflow: true });
      await rm(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git'), 'gitdir: example');
      expect(workspacePathInventory(root, 250_000).entries.some(entry => entry.path === '.git')).toBe(false);
      const deep = join(root, ...Array.from({ length: 70 }, () => 'd'));
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, 'leaf.ts'), 'neutral');
      expect(workspacePathInventory(root, 250_000).entries.some(entry => entry.name === 'leaf.ts')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses real SQLite trigram candidates while retaining oversized, binary and Unicode uncertainty', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp', 'trigram-index-'));
    const path = join(root, 'cache', 'index.sqlite');
    const epoch = 'first';
    try {
      await Promise.all([
        writeFile(join(root, 'match.ts'), 'Needle exact 中文内容 marker'),
        writeFile(join(root, 'other.ts'), 'unrelated text'),
        writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2])),
        writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語', 'utf16le')])),
        writeFile(join(root, 'large.txt'), 'x'.repeat((1 << 20) + 1)),
      ]);
      const entries = workspacePathInventory(root, 250_000).entries.filter(entry => entry.kind === 'file');
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.begin', path, epoch })).toBe(true);
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.update', path, epoch, root, entries })).toBe(true);
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.query', path, epoch, literal: 'Needle', insensitive: false, limit: 10 })).toBeUndefined();
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.finish', path, epoch })).toBe(true);
      const query = (literal: string, insensitive = false) => executeWorkspaceTrigram({ type: 'workspace.trigram.query', path, epoch, literal, insensitive, limit: 10 });
      expect(query('Needle')).toEqual(expect.arrayContaining(['match.ts', 'binary.dat', 'large.txt']));
      expect(query('中文内容')).toContain('match.ts');
      expect(query('日本語')).toContain('utf16.txt');
      expect(query('absent')).toEqual(expect.arrayContaining(['binary.dat', 'large.txt']));
      expect(query('absent', true)).toContain('match.ts');
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.query', path, epoch: 'wrong', literal: 'Needle', insensitive: false, limit: 10 })).toBeUndefined();
      await rm(join(root, 'match.ts'));
      const next = 'second';
      executeWorkspaceTrigram({ type: 'workspace.trigram.begin', path, epoch: next });
      executeWorkspaceTrigram({ type: 'workspace.trigram.update', path, epoch: next, root, entries: entries.filter(entry => entry.path !== 'match.ts') });
      executeWorkspaceTrigram({ type: 'workspace.trigram.finish', path, epoch: next });
      expect(executeWorkspaceTrigram({ type: 'workspace.trigram.query', path, epoch: next, literal: 'Needle', insensitive: false, limit: 10 })).not.toContain('match.ts');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['\\d+', 'foo|bar', '(foo)?bar', '[a-z]+', 'foo\nbar', '^foo$', 'ab'])('does not prefilter a regex without a safe required trigram: %s', pattern => {
    expect(requiredGrepLiteral(pattern, false)).toBeUndefined();
  });

  it('extracts required regex prefixes without treating optional characters or alternatives as required', () => {
    expect(requiredGrepLiteral('a.b', true)).toBe('a.b');
    expect(requiredGrepLiteral('ordinaryName', false)).toBe('ordinaryName');
    expect(requiredGrepLiteral('中文内容', true)).toBe('中文内容');
    expect(requiredGrepLiteral('uniqueNeedle.*after', false)).toBe('uniqueNeedle');
    expect(requiredGrepLiteral('uniqueNeedle\\s+=\\s+\\d+', false)).toBe('uniqueNeedle');
    expect(requiredGrepLiteral('optional?', false)).toBe('optiona');
    expect(requiredGrepLiteral('optional{0}suffix', false)).toBe('optiona');
    expect(requiredGrepLiteral('foo\\.bar\\|baz', false)).toBe('foo.bar|baz');
    expect(requiredGrepLiteral('required|alternative', false)).toBeUndefined();
    expect(requiredGrepLiteral('abc?', false)).toBeUndefined();
    expect(requiredGrepLiteral('中文🙂?suffix', false)).toBeUndefined();
  });
});
