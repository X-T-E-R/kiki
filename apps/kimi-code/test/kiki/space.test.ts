import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalTreeDigest,
  parsePortableEndpoint,
  registerSpaceCommand,
  type SpaceCommandDependencies,
} from '../../src/kiki/space';

const connection = { url: 'http://127.0.0.1:58627', token: 'owner-token', serverId: 'server-fixture' };

function sourceList() {
  return {
    deviceRecipient: 'age1device',
    knownRecipients: [{ recipient: 'age1device', label: 'device' }],
    items: [],
  };
}

function linkedSourceList() {
  return {
    ...sourceList(),
    items: [{
      id: 'linked-source',
      label: 'linked source',
      endpoint: { kind: 'archive' as const, path: '/tmp/linked.kiki.tgz' },
      linkedSpaceId: 'main' as const,
      format: 'tgz' as const,
    }],
  };
}

function exportReceipt() {
  return {
    destination: 'space.kiki.tgz',
    format: 'tgz',
    spaceMode: 'full',
    secretMode: 'none',
    encryptionMode: 'none',
    domains: [],
    totalItems: 0,
  };
}

function inspect() {
  return {
    endpoint: { kind: 'live', spaceId: 'main' },
    label: 'main',
    format: 'dir',
    spaceMode: 'full',
    secretMode: 'none',
    encryptionMode: 'none',
    recipients: [],
    unset: [],
    domains: [],
    items: [],
  };
}

function mutateReceipt() {
  return { changed: true, appliedOps: 1, inspect: inspect() };
}

function preview() {
  return {
    previewToken: 'preview-token',
    mode: 'merge',
    hasVerifiedBase: false,
    sourceLabels: ['source'],
    targetLabel: 'main',
    rows: [],
    unchangedCount: 0,
    conflictCount: 0,
    dependencyErrors: [],
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

function applyReceipt() {
  return { mode: 'sync', appliedIds: [], skippedIds: [], deletedIds: [], restartRequired: false };
}

function makeHarness(dataFor: (path: string, body: unknown) => unknown, confirm?: () => Promise<boolean>) {
  const requests: { path: string; method: string; body: unknown; headers: Headers }[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: SpaceCommandDependencies = {
    ensureServer: vi.fn(async () => connection),
    stdout: { write: (chunk) => { stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); } },
    stderr: { write: (chunk) => { stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); } },
    confirm,
    fetch: vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
      return Response.json({ code: 0, msg: 'success', data: dataFor(path, body) });
    }),
  };
  return { dependencies, requests, stdout, stderr };
}

async function parse(dependencies: SpaceCommandDependencies, ...args: string[]) {
  const program = new Command('kiki').exitOverride();
  registerSpaceCommand(program, dependencies);
  await program.parseAsync(['space', ...args], { from: 'user' });
}

describe('portable Space CLI', () => {
  it('parses live, archive, directory, and git endpoint forms', () => {
    expect(parsePortableEndpoint('main')).toEqual({ kind: 'live', spaceId: 'main' });
    expect(parsePortableEndpoint('archive:./backup.kiki.tgz')).toMatchObject({ kind: 'archive', path: expect.stringContaining('backup.kiki.tgz') });
    expect(parsePortableEndpoint('dir:./space')).toMatchObject({ kind: 'dir', path: expect.stringContaining('space') });
    expect(parsePortableEndpoint('github:owner/repo#main//skills')).toEqual({ kind: 'git', repo: 'github:owner/repo', ref: 'main', subpath: 'skills' });
    expect(parsePortableEndpoint('github:owner/repo//skills')).toEqual({ kind: 'git', repo: 'github:owner/repo', subpath: 'skills' });
    expect(parsePortableEndpoint('https://github.com/owner/repo')).toEqual({ kind: 'git', repo: 'https://github.com/owner/repo' });
    expect(parsePortableEndpoint('https://github.com/owner/repo//skills')).toEqual({ kind: 'git', repo: 'https://github.com/owner/repo//skills' });
  });

  it('names the age unlock environment variables in subcommand help', () => {
    const program = new Command('kiki');
    const space = registerSpaceCommand(program);
    const unpack = space.commands.find((command) => command.name() === 'unpack');
    expect(unpack?.helpInformation()).toContain('KIKI_AGE_PASSPHRASE');
    expect(unpack?.helpInformation()).toContain('KIKI_AGE_KEY');
  });

  it('keeps canonical tree digests independent of insertion order', () => {
    const one = new Map([['config.toml', Buffer.from('a')], ['mcp.json', Buffer.from('b')]]);
    const two = new Map([['mcp.json', Buffer.from('b')], ['config.toml', Buffer.from('a')]]);
    expect(canonicalTreeDigest(one)).toBe(canonicalTreeDigest(two));
    expect(canonicalTreeDigest(one)).not.toBe(canonicalTreeDigest(new Map([['config.toml', Buffer.from('changed')]])));
  });

  it('maps set assignments to one locked mutate request with owner auth', async () => {
    const harness = makeHarness((path) => path.endsWith('/mutate') ? mutateReceipt() : sourceList());
    await parse(harness.dependencies, 'set', 'main', 'config.theme="dark"', 'config.foldSteps=true');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      path: '/api/spaces/portable/mutate',
      method: 'POST',
      body: {
        target: { kind: 'live', spaceId: 'main' },
        actions: [
          { op: 'set', key: 'config.theme', value: 'dark' },
          { op: 'set', key: 'config.foldSteps', value: true },
        ],
      },
    });
    expect(harness.requests[0]!.headers.get('authorization')).toBe('Bearer owner-token');
  });

  it('maps export <dest> and preserves bare --include-sessions with --git-init', async () => {
    const harness = makeHarness((path) => path.endsWith('/export') ? exportReceipt() : sourceList());
    await parse(harness.dependencies, 'export', './space-dir', '--git-init', '--include-sessions');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      path: '/api/spaces/portable/export',
      body: {
        destination: expect.stringContaining('space-dir'),
        gitInit: true,
        sessions: { mode: 'recent', count: 20 },
      },
    });
  });

  it('maps delta source, --since, recent session selection, and -o without using a legacy sync route', async () => {
    const harness = makeHarness((path) => path.endsWith('/delta') ? { destination: 'delta.tgz' } : sourceList());
    await parse(harness.dependencies, 'delta', '--since', 'archive:./old.kiki.tgz', '--include-sessions', 'recent:51', '-o', './delta.kiki.tgz');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      path: '/api/spaces/portable/delta',
      body: {
        source: { kind: 'live', spaceId: 'main' },
        since: { kind: 'archive', path: expect.stringContaining('old.kiki.tgz') },
        destination: expect.stringContaining('delta.kiki.tgz'),
        sessions: { mode: 'recent', count: 51 },
      },
    });
  });

  it('accepts the documented positional delta destination as an implicit live source', async () => {
    const harness = makeHarness((path) => path.endsWith('/delta') ? { destination: 'delta.tgz' } : sourceList());
    await parse(harness.dependencies, 'delta', '--since', 'archive:./old.kiki.tgz', './delta.kiki.tgz');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      path: '/api/spaces/portable/delta',
      body: {
        source: { kind: 'live', spaceId: 'main' },
        since: { kind: 'archive', path: expect.stringContaining('old.kiki.tgz') },
        destination: expect.stringContaining('delta.kiki.tgz'),
      },
    });
  });

  it('uses preview then apply for pull and maps Git push branches into target refs', async () => {
    const harness = makeHarness((path) => path.endsWith('/preview') ? preview() : path.endsWith('/apply') ? applyReceipt() : sourceList(), async () => true);
    await parse(harness.dependencies, 'pull', 'archive:./source.kiki.tgz', 'main', '--yes');
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/api/spaces/portable/preview',
      '/api/spaces/portable/apply',
    ]);

    const pushed = makeHarness((path) => path.endsWith('/preview') ? { ...preview(), mode: 'override' } : path.endsWith('/apply') ? applyReceipt() : sourceList());
    await parse(pushed.dependencies, 'push', 'git:github:owner/repo', 'main', '--branch', 'release', '--yes');
    const previewRequest = pushed.requests.find((request) => request.path.endsWith('/preview'))!;
    expect(previewRequest.body).toMatchObject({ target: { kind: 'git', repo: 'github:owner/repo', ref: 'release' }, mode: 'override' });
  });

  it('reads key show from sources and posts key add to recipients', async () => {
    const harness = makeHarness((path) => path.endsWith('/sources') ? sourceList() : { added: true });
    await parse(harness.dependencies, 'key', 'show');
    expect(harness.requests[0]).toMatchObject({ path: '/api/spaces/portable/sources', method: 'GET' });
    await parse(harness.dependencies, 'key', 'add', 'age1new', '--label', 'laptop');
    expect(harness.requests[1]).toMatchObject({
      path: '/api/spaces/portable/recipients',
      method: 'POST',
      body: { recipient: 'age1new', label: 'laptop' },
    });
  });

  it('maps ordered layer sources and dry-run without committing changes', async () => {
    const harness = makeHarness(() => ({ ...preview(), mode: 'override' }));
    await parse(harness.dependencies, 'apply', 'base.kiki.age', 'overlay.kiki.age', '--to', 'main', '--override', '--platform', 'linux', '--only', 'config,mcp', '--dry-run');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.body).toMatchObject({
      mode: 'override', targetPlatform: 'linux', domains: ['config', 'mcp'], sources: [
        { kind: 'archive', path: expect.stringMatching(/base\.kiki\.age$/) },
        { kind: 'archive', path: expect.stringMatching(/overlay\.kiki\.age$/) },
      ],
    });
  });

  it('accepts variadic apply sources with --override, --home, and --yes', async () => {
    const harness = makeHarness((path) => path.endsWith('/preview') ? { ...preview(), mode: 'override' } : path.endsWith('/apply') ? applyReceipt() : sourceList());
    const ensureServer = vi.fn(async () => connection);
    await parse({ ...harness.dependencies, ensureServer }, 'apply', 'base.kiki.age', 'overlay.kiki.age', '--override', '--home', './portable-home', '--yes');
    expect(ensureServer).toHaveBeenCalledWith({ homeDir: resolve('./portable-home') });
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/api/spaces/portable/preview',
      '/api/spaces/portable/apply',
    ]);
    expect(harness.requests[0]?.body).toMatchObject({
      mode: 'override',
      sources: [
        { kind: 'archive', path: expect.stringMatching(/base\.kiki\.age$/) },
        { kind: 'archive', path: expect.stringMatching(/overlay\.kiki\.age$/) },
      ],
    });
  });

  it('allows sync to choose the unique linked source when left is omitted and honors --only', async () => {
    const harness = makeHarness((path) => path.endsWith('/sources') ? linkedSourceList() : path.endsWith('/preview') ? { ...preview(), mode: 'sync' } : path.endsWith('/apply') ? applyReceipt() : sourceList());
    await parse(harness.dependencies, 'sync', '--only', 'config', '--yes');
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/api/spaces/portable/sources',
      '/api/spaces/portable/preview',
      '/api/spaces/portable/apply',
    ]);
    expect(harness.requests[1]?.body).toMatchObject({
      mode: 'sync',
      domains: ['config'],
      sources: [{ kind: 'archive', path: '/tmp/linked.kiki.tgz' }],
      target: { kind: 'live', spaceId: 'main' },
    });
  });

  it('rejects an omitted sync left when there is not exactly one linked source', async () => {
    const harness = makeHarness((path) => path.endsWith('/sources') ? sourceList() : { ...preview(), mode: 'sync' });
    await expect(parse(harness.dependencies, 'sync', '--yes')).rejects.toThrow('Specify a source ID unless exactly one source is linked to this Home');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.path).toBe('/api/spaces/portable/sources');
  });

  it('passes archive bytes only to the recipient that the remote Kiki publishes', async () => {
    const harness = makeHarness(() => ({ destination: 'clone.kiki.age', format: 'age', spaceMode: 'full', secretMode: 'sealed', encryptionMode: 'x25519', domains: [], totalItems: 1 }));
    const exportFetch = harness.dependencies.fetch!;
    const runRemote = vi.fn(async (_program: string, args: string[], archive?: string) => {
      if (!archive) {
        expect(args.at(-1)).toContain('exec kiki space key show --json');
        return JSON.stringify(sourceList());
      }
      expect(args.at(-1)).toContain('exec kiki space apply - --override --yes --json');
      expect(await readFile(archive, 'utf8')).toBe('fixture-age-bytes');
      return JSON.stringify({ ...applyReceipt(), mode: 'override' });
    });
    await parse({ ...harness.dependencies, runRemote, fetch: async (input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request body.');
      const body = JSON.parse(init.body) as { destination: string };
      await writeFile(body.destination, 'fixture-age-bytes');
      return exportFetch(input, init);
    } }, 'clone', 'ssh://deployer@example.test:2222', '--session', 'test-session', '--only', 'config');
    expect(harness.requests[0]?.body).toMatchObject({
      format: 'age', encryption: { mode: 'x25519', recipients: ['age1device'] },
      domains: ['config', 'sessions'], sessions: { mode: 'ids', sessionIds: ['test-session'] },
    });
    expect(runRemote.mock.calls[0]?.[1].slice(0, 5)).toEqual(['-T', '-p', '2222', '--', 'deployer@example.test']);
  });

  it('does not mutate an archive when the editor leaves canonical bytes unchanged', async () => {
    const harness = makeHarness(() => ({ destination: 'vacant', format: 'dir', spaceMode: 'full', secretMode: 'plain', encryptionMode: 'none', domains: [], totalItems: 1 }));
    const fetch = harness.dependencies.fetch!;
    const editor = vi.fn(async (path: string) => { expect(await readFile(path, 'utf8')).toBe('default_model = "demo"\n'); });
    await parse({ ...harness.dependencies, editor, fetch: async (input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request body.');
      const body = JSON.parse(init.body) as { destinationPath: string };
      await writeFile(join(body.destinationPath, 'config.toml'), 'default_model = "demo"\n');
      return fetch(input, init);
    } }, 'edit', 'portable.kiki.age');
    expect(harness.requests.map((item) => item.path)).toEqual(['/api/spaces/portable/unpack']);
    expect(harness.requests[0]?.body).toMatchObject({
      action: 'unpack', secretMode: 'plain', destinationPath: expect.stringContaining('kiki-space-edit-'),
    });
    expect(harness.stdout.join('')).toContain('No changes; archive untouched');
    expect(editor).toHaveBeenCalledTimes(1);
  });

  it('seals credentials by default when unpacking', async () => {
    const harness = makeHarness((path) => path.endsWith('/unpack') ? {
      destination: 'unpacked', format: 'tgz', spaceMode: 'full', secretMode: 'sealed', encryptionMode: 'none',
      domains: [], totalItems: 0, bytes: 0,
    } : sourceList());
    await parse(harness.dependencies, 'unpack', './space.kiki.tgz', './space-dir');
    expect(harness.requests[0]).toMatchObject({
      path: '/api/spaces/portable/unpack',
      body: { action: 'unpack', format: 'tgz', secretMode: 'sealed' },
    });
  });

  it('uses plaintext only with the explicit switch and lets --no-credentials win', async () => {
    const plainUnpack = makeHarness((path) => path.endsWith('/unpack') ? {
      destination: 'unpacked', format: 'tgz', spaceMode: 'full', secretMode: 'plain', encryptionMode: 'none',
      domains: [], totalItems: 0, bytes: 0,
    } : sourceList());
    await parse(plainUnpack.dependencies, 'unpack', './space.kiki.tgz', './space-dir', '--include-secrets-plain');
    expect(plainUnpack.requests[0]?.body).toMatchObject({ secretMode: 'plain' });

    const noCredentialsUnpack = makeHarness((path) => path.endsWith('/unpack') ? {
      destination: 'unpacked', format: 'tgz', spaceMode: 'full', secretMode: 'none', encryptionMode: 'none',
      domains: [], totalItems: 0, bytes: 0,
    } : sourceList());
    await parse(noCredentialsUnpack.dependencies, 'unpack', './space.kiki.tgz', './space-dir', '--include-secrets-plain', '--no-credentials');
    expect(noCredentialsUnpack.requests[0]?.body).toMatchObject({ secretMode: 'none' });

    const plainExport = makeHarness((path) => path.endsWith('/export') ? {
      ...exportReceipt(), secretMode: 'plain', format: 'dir',
    } : sourceList());
    await parse(plainExport.dependencies, 'export', './space-dir', '--include-secrets-plain');
    expect(plainExport.requests[0]?.body).toMatchObject({ secretMode: 'plain' });

    const noCredentialsExport = makeHarness((path) => path.endsWith('/export') ? exportReceipt() : sourceList());
    await parse(noCredentialsExport.dependencies, 'export', './space-dir', '--include-secrets-plain', '--no-credentials');
    expect(noCredentialsExport.requests[0]?.body).toMatchObject({ secretMode: 'none' });
  });
});
