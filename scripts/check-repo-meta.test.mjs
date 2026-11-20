import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { checkRepoMeta, formatViolation } from './check-repo-meta.mjs';

const fixtures = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(root, relPath, content) {
  const target = join(root, ...relPath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function createCleanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kiki-repo-meta-'));
  fixtures.push(root);

  write(root, 'CLAUDE.md', '@AGENTS.md\n');
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - apps/*\n');
  write(
    root,
    'flake.nix',
    [
      'workspacePaths = [',
      '  ./apps/cli',
      '  ./packages/session-core',
      '  ./packages/transcript',
      '];',
      'workspaceNames = [',
      '  "@kiki/cli"',
      '  "@kiki/session-core"',
      '  "@kiki/transcript"',
      '];',
      '',
    ].join('\n'),
  );

  write(
    root,
    'AGENTS.md',
    [
      '# Guide',
      '',
      '## Workspace Map',
      '',
      '| Path | Role |',
      '| --- | --- |',
      '| `apps/cli` | CLI app; see `apps/cli/AGENTS.md`. |',
      '| `apps/native-shell` | Non-npm native shell. |',
      '| `packages/session-core` | Session state; see `packages/session-core/AGENTS.md`. |',
      '| `packages/transcript` | Transcript layer; see `packages/transcript/AGENTS.md`. |',
      '',
      '## Links',
      '',
      'See [maintainers](MAINTAINERS.md) and `apps/*/AGENTS.md`.',
      '',
    ].join('\n'),
  );

  write(
    root,
    'MAINTAINERS.md',
    [
      '# Maintainers',
      '',
      '| Area | Instructions |',
      '| --- | --- |',
      '| CLI | [`apps/cli/AGENTS.md`](apps/cli/AGENTS.md) |',
      '| Session | [`packages/session-core/AGENTS.md`](packages/session-core/AGENTS.md) |',
      '| Transcript | [`packages/transcript/AGENTS.md`](packages/transcript/AGENTS.md) |',
      '',
      '## Generated contracts',
      '',
      '| Projection | Generator |',
      '| --- | --- |',
      '| `packages/transcript/generated.d.ts` | `scripts/gen.mjs` |',
      '',
    ].join('\n'),
  );

  write(root, 'scripts/gen.mjs', 'export const ok = true;\n');
  write(root, 'packages/transcript/generated.d.ts', 'export type Ok = true;\n');

  write(root, 'apps/native-shell/README.md', '# Native Shell\n');

  write(
    root,
    'apps/cli/package.json',
    JSON.stringify(
      {
        name: '@kiki/cli',
        dependencies: { '@kiki/session-core': 'workspace:*' },
      },
      null,
      2,
    ),
  );
  write(root, 'apps/cli/AGENTS.md', '# CLI Guide\n\nUses `@kiki/session-core`.\n');
  write(root, 'apps/cli/src/main.ts', "import { state } from '@kiki/session-core';\nexport const run = () => state;\n");

  write(
    root,
    'packages/session-core/package.json',
    JSON.stringify(
      {
        name: '@kiki/session-core',
        dependencies: { '@kiki/transcript': 'workspace:*' },
      },
      null,
      2,
    ),
  );
  write(root, 'packages/session-core/AGENTS.md', '# Session Core\n\nDepends on `@kiki/transcript`.\n');
  write(
    root,
    'packages/session-core/src/index.ts',
    [
      "import { store } from '@kiki/transcript';",
      'const note = "window.location inside a string literal is fine";',
      '// localStorage.getItem in a comment is fine',
      'export const state = { store, note };',
      '',
    ].join('\n'),
  );

  write(
    root,
    'packages/transcript/package.json',
    JSON.stringify({ name: '@kiki/transcript', dependencies: {} }, null, 2),
  );
  write(root, 'packages/transcript/AGENTS.md', '# Transcript\n\nPure TypeScript.\n');
  write(root, 'packages/transcript/src/index.ts', 'export const store = 1;\n');

  write(
    root,
    'config/doc-budgets.json',
    JSON.stringify(
      {
        defaults: { subtreeAgentsMaxWords: 200 },
        files: {
          'AGENTS.md': { maxWords: 120, maxLines: 40 },
          'MAINTAINERS.md': { maxWords: 120 },
        },
      },
      null,
      2,
    ),
  );

  const boundaries = {
    NON_NPM_SURFACES: ['apps/native-shell'],
    IGNORED_NON_WORKSPACE_DIRS: new Set(),
    RETIRED_SCOPE_PATTERNS: [
      {
        pattern: /@moonshot-ai\/[a-z0-9-]+/g,
        fix: 'Replace retired @moonshot-ai/* scope with @kiki/*.',
      },
      {
        pattern: /\bpackages\/agent-core(?![-a-z0-9])/g,
        fix: 'Replace retired packages/agent-core reference with packages/agent-core-v2.',
      },
      {
        pattern: /\bkimi-code-mini-bench\b/g,
        fix: 'Remove dead kimi-code-mini-bench reference.',
      },
      {
        pattern: /@kiki\/minidb\b|\bpackages\/minidb\b/g,
        fix: 'Remove retired @kiki/minidb reference.',
      },
      {
        pattern: /@kiki\/dsh-compat\b|\bpackages\/dsh-compat\b/g,
        fix: 'Remove retired @kiki/dsh-compat reference.',
      },
    ],
    THROWAWAY_FILE_PATTERNS: [
      {
        pattern: /(?:^|\/)(?:HANDOVER-|HANDOFF-|handoff\.md)/i,
        reason: 'tracked agent handoff/working note',
      },
      {
        pattern: /(?:^|\/)[^/]+-(?:mockup|demo|demos|designs)\.html$/i,
        reason: 'tracked throwaway HTML mockup/demo',
      },
    ],
    BOUNDARY_RULES: [
      {
        id: 'transcript',
        root: 'packages/transcript',
        allowedInternal: new Set([]),
        forbiddenInternal: new Set(['@kiki/agent-core-v2']),
        forbiddenExternal: [/^react(?:$|\/)/, /^node:/],
        forbiddenGlobals: ['window', 'document', 'localStorage'],
        forbiddenPlatformFlags: ['isTauri', 'isNative'],
      },
      {
        id: 'session-core',
        root: 'packages/session-core',
        allowedInternal: new Set(['@kiki/transcript']),
        forbiddenInternal: new Set(['@kiki/agent-core-v2', '@kiki/kap-server']),
        forbiddenExternal: [/^react(?:$|\/)/, /^@tauri-apps\//],
        forbiddenGlobals: ['window', 'document', 'localStorage'],
        forbiddenPlatformFlags: ['isTauri', 'isCapacitor', 'isNative'],
      },
      {
        id: 'cli',
        root: 'apps/cli',
        forbiddenInternal: new Set(['@kiki/agent-core-v2']),
        forbiddenExternal: [/^react(?:$|\/)/],
        forbiddenGlobals: [],
        forbiddenPlatformFlags: [],
      },
    ],
  };

  return { root, boundaries };
}

function assertFormattedWithFix(error, expectedRule) {
  assert.equal(error.rule, expectedRule);
  const formatted = formatViolation(error);
  assert.match(formatted, new RegExp(`^\\[${expectedRule}\\] .+:\\d+ — .+\\. Fix: .+\\.$`));
}

void test('passes with zero violations on a clean synthetic repository', async () => {
  const { root, boundaries } = createCleanFixture();
  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  assert.deepEqual(errors, []);
});

void test('passes with zero violations on the live repository', async () => {
  const repoRoot = resolve(import.meta.dirname, '..');
  const errors = await checkRepoMeta(repoRoot);
  assert.deepEqual(errors.map(formatViolation), []);
});

void test('rule 1 [claude-md-pointer] rejects missing @ prefix and invalid nested CLAUDE.md', async () => {
  const { root, boundaries } = createCleanFixture();
  write(root, 'CLAUDE.md', 'AGENTS.md\n');
  write(root, 'apps/cli/CLAUDE.md', 'See AGENTS.md\n');

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'claude-md-pointer');
  assert.equal(hits.length, 2);
  for (const hit of hits) assertFormattedWithFix(hit, 'claude-md-pointer');
});

void test('rule 2 [workspace-agents-parity] catches missing, stale, and unregistered dirs while ignoring node_modules-only ghosts', async () => {
  const { root, boundaries } = createCleanFixture();
  write(root, 'packages/ghost-cache/node_modules/pkg/index.js', 'export {};\n');
  write(root, 'apps/rogue/README.md', '# Unregistered\n');
  write(
    root,
    'AGENTS.md',
    [
      '# Guide',
      '',
      '## Workspace Map',
      '',
      '| Path | Role |',
      '| --- | --- |',
      '| `apps/cli` | CLI |',
      '| `apps/native-shell` | Native |',
      '| `packages/transcript` | Transcript |',
      '| `packages/deleted-pkg` | Ghost |',
      '',
    ].join('\n'),
  );

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'workspace-agents-parity');
  assert.ok(hits.some((e) => e.message.includes('packages/session-core')));
  assert.ok(hits.some((e) => e.message.includes('packages/deleted-pkg')));
  assert.ok(hits.some((e) => e.file === 'apps/rogue'));
  assert.ok(!hits.some((e) => e.file.includes('ghost-cache')));
  for (const hit of hits) assertFormattedWithFix(hit, 'workspace-agents-parity');
});

void test('rule 3 [banned-stale-scopes] catches retired scopes while skipping fences and historical markers', async () => {
  const { root, boundaries } = createCleanFixture();
  write(
    root,
    'packages/session-core/AGENTS.md',
    [
      '# Session Core',
      '',
      'Depends on `@moonshot-ai/protocol` and `@kiki/minidb` and `@kiki/dsh-compat`.',
      'Old path `packages/agent-core` and `kimi-code-mini-bench`.',
      'Historical note about `@moonshot-ai/legacy`. <!-- historical -->',
      '```md',
      'Example of banned `@moonshot-ai/in-fence` ignored.',
      '```',
      '',
    ].join('\n'),
  );

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'banned-stale-scopes');
  assert.equal(hits.length, 5);
  assert.ok(hits.every((e) => e.line === 3 || e.line === 4));
  for (const hit of hits) assertFormattedWithFix(hit, 'banned-stale-scopes');
});

void test('rule 4 [meta-doc-links] catches dead markdown links and backticked repo paths while skipping inline-code examples', async () => {
  const { root, boundaries } = createCleanFixture();
  write(
    root,
    'apps/cli/AGENTS.md',
    [
      '# CLI Guide',
      '',
      'Broken [doc](./does-not-exist.md).',
      'Broken path `packages/session-core/src/missing.ts`.',
      'Illustrative `[example](./config.md)` wrapped in inline code.',
      '',
    ].join('\n'),
  );

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'meta-doc-links');
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((e) => e.line).toSorted((a, b) => a - b),
    [3, 4],
  );
  for (const hit of hits) assertFormattedWithFix(hit, 'meta-doc-links');
});

void test('rule 5 [maintainers-router-parity] catches unlinked subtree AGENTS.md and missing generated contract paths', async () => {
  const { root, boundaries } = createCleanFixture();
  write(
    root,
    'MAINTAINERS.md',
    [
      '# Maintainers',
      '',
      '| Area | Instructions |',
      '| --- | --- |',
      '| CLI | [`apps/cli/AGENTS.md`](apps/cli/AGENTS.md) |',
      '| Session | [`packages/session-core/AGENTS.md`](packages/session-core/AGENTS.md) |',
      '',
      '## Generated contracts',
      '',
      '| Projection | Generator |',
      '| --- | --- |',
      '| `packages/transcript/missing.d.ts` | `scripts/missing-gen.mjs` |',
      '',
    ].join('\n'),
  );

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'maintainers-router-parity');
  assert.equal(hits.length, 3);
  assert.ok(hits.some((e) => e.message.includes('packages/transcript/AGENTS.md')));
  assert.ok(hits.some((e) => e.message.includes('packages/transcript/missing.d.ts')));
  assert.ok(hits.some((e) => e.message.includes('scripts/missing-gen.mjs')));
  for (const hit of hits) assertFormattedWithFix(hit, 'maintainers-router-parity');
});

void test('rule 6 [doc-word-budgets] catches documents exceeding word or line ceilings', async () => {
  const { root, boundaries } = createCleanFixture();
  const bloated = ['# Transcript', '', ...Array.from({ length: 220 }, (_, i) => `word${i}`)].join(' ');
  write(root, 'packages/transcript/AGENTS.md', bloated);

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'doc-word-budgets');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'packages/transcript/AGENTS.md');
  assertFormattedWithFix(hits[0], 'doc-word-budgets');
});

void test('rule 7 [pkg-boundary-graph] catches forbidden deps, imports, escapes, undeclared @kiki imports, DOM globals, and platform flags', async () => {
  const { root, boundaries } = createCleanFixture();
  write(
    root,
    'packages/session-core/package.json',
    JSON.stringify(
      {
        name: '@kiki/session-core',
        dependencies: {
          '@kiki/transcript': 'workspace:*',
          '@kiki/agent-core-v2': 'workspace:*',
          react: '^19.0.0',
        },
      },
      null,
      2,
    ),
  );
  write(
    root,
    'packages/session-core/src/bad.ts',
    [
      "import { foo } from '@kiki/agent-core-v2';",
      "import { bar } from '@kiki/klient';",
      "import { raw } from '../../transcript/src/index';",
      'const host = window.location.href;',
      'const mobile = isTauri ? 1 : 0;',
      'export const leak = { foo, bar, raw, host, mobile };',
      '',
    ].join('\n'),
  );
  write(
    root,
    'packages/transcript/src/bad-node.ts',
    "const fsMod = await import('node:fs');\nexport default fsMod;\n",
  );

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'pkg-boundary-graph');
  assert.ok(hits.some((e) => e.file === 'packages/session-core/package.json' && e.message.includes('@kiki/agent-core-v2')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/package.json' && e.message.includes('react')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/src/bad.ts' && e.message.includes('Forbidden internal import')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/src/bad.ts' && e.message.includes('Undeclared internal package import')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/src/bad.ts' && e.message.includes('escapes package root')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/src/bad.ts' && e.message.includes('Forbidden host/DOM global "window"')));
  assert.ok(hits.some((e) => e.file === 'packages/session-core/src/bad.ts' && e.message.includes('Forbidden runtime platform flag "isTauri"')));
  assert.ok(hits.some((e) => e.file === 'packages/transcript/src/bad-node.ts' && e.message.includes('node:fs')));
  for (const hit of hits) assertFormattedWithFix(hit, 'pkg-boundary-graph');
});

void test('rule 8 [workspace-sync-and-hygiene] catches flake.nix drift and tracked scratch files', async () => {
  const { root, boundaries } = createCleanFixture();
  write(
    root,
    'flake.nix',
    [
      'workspacePaths = [',
      '  ./apps/cli',
      '  ./packages/stale-entry',
      '];',
      'workspaceNames = [',
      '  "@kiki/cli"',
      '  "@kiki/stale-entry"',
      '];',
      '',
    ].join('\n'),
  );
  write(root, 'HANDOVER-2026.md', '# Scratch\n');
  write(root, 'design/landing-mockup.html', '<html></html>\n');

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'workspace-sync-and-hygiene');
  assert.ok(hits.some((e) => e.file === 'flake.nix' && e.message.includes('@kiki/session-core')));
  assert.ok(hits.some((e) => e.file === 'flake.nix' && e.message.includes('@kiki/stale-entry')));
  assert.ok(hits.some((e) => e.file === 'HANDOVER-2026.md'));
  assert.ok(hits.some((e) => e.file === 'design/landing-mockup.html'));
  for (const hit of hits) assertFormattedWithFix(hit, 'workspace-sync-and-hygiene');
});

void test('rule 9 [pii-and-internal-hosts] catches real user-profile paths and non-placeholder LAN IPs in scripts', async () => {
  const { root, boundaries } = createCleanFixture();
  write(root, 'docs/leak.md', 'See C:/Users/realperson99/secret/config.toml and /Users/realmacuser/work\n');
  write(root, 'scripts/leak.mjs', 'const host = "192.168.77.88";\n');
  write(root, 'docs/safe.md', 'See C:/Users/alice/project and /Users/bob/project\n');
  write(root, 'scripts/safe.mjs', 'const host = "192.168.1.10";\n');

  const errors = await checkRepoMeta(root, { boundaries, trackedFiles: null });
  const hits = errors.filter((e) => e.rule === 'pii-and-internal-hosts');
  assert.ok(hits.some((e) => e.file === 'docs/leak.md' && e.message.includes('realperson99')));
  assert.ok(hits.some((e) => e.file === 'docs/leak.md' && e.message.includes('realmacuser')));
  assert.ok(hits.some((e) => e.file === 'scripts/leak.mjs' && e.message.includes('192.168.77.88')));
  assert.ok(!hits.some((e) => e.file === 'docs/safe.md'));
  assert.ok(!hits.some((e) => e.file === 'scripts/safe.mjs'));
  for (const hit of hits) assertFormattedWithFix(hit, 'pii-and-internal-hosts');
});
