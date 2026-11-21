import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  applyRatchet,
  checkCodeHealth,
  DEFAULT_MAX_NEW_FILE_LINES,
  formatCodeHealthViolation,
} from './check-code-health.mjs';

const SCRIPT_PATH = join(import.meta.dirname, 'check-code-health.mjs');
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(root, relPath, content) {
  const abs = join(root, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function makeLines(count, prefix = 'export const line') {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1} = ${idx + 1};`).join('\n');
}

function createFixtureRepo(baselineOverride = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kiki-code-health-'));
  tempDirs.push(root);
  const baseline = {
    schema: 1,
    maxNewFileLines: DEFAULT_MAX_NEW_FILE_LINES,
    monolithMaxLines: {},
    internalTestMocks: {},
    emojiAllowedFiles: {},
    ...baselineOverride,
  };
  writeFixture(root, 'scripts/code-health-baseline.json', `${JSON.stringify(baseline, null, 2)}\n`);
  writeFixture(root, 'apps/kiki-gui/src/components/CleanView.tsx', 'export function CleanView() { return <div>ok</div>; }\n');
  writeFixture(root, 'apps/kiki-gui/AGENTS.md', '# GUI\n\nSee `src/components/CleanView.tsx`.\n');
  return root;
}

describe('check-code-health deterministic ratchets', () => {
  it('passes cleanly on a compliant repo fixture', () => {
    const root = createFixtureRepo();
    const report = checkCodeHealth(root);
    assert.equal(report.ok, true);
    assert.equal(report.violations.length, 0);
  });

  it('fails when a brand-new production file exceeds 600 lines', () => {
    const root = createFixtureRepo();
    writeFixture(root, 'packages/session-core/src/huge.ts', makeLines(601));
    const report = checkCodeHealth(root);
    assert.equal(report.ok, false);
    const v = report.violations.find((item) => item.rule === 'monolith-ratchet');
    assert.ok(v, 'expected monolith-ratchet violation');
    assert.equal(v.file, 'packages/session-core/src/huge.ts');
    assert.match(formatCodeHealthViolation(v), /601 lines.*600-line ceiling/);
  });

  it('fails when a baselined monolith grows by +1 line and ratchets downward when it shrinks', () => {
    const root = createFixtureRepo({
      monolithMaxLines: {
        'apps/kiki-gui/src/components/LegacyMonolith.tsx': 650,
      },
    });
    writeFixture(root, 'apps/kiki-gui/src/components/LegacyMonolith.tsx', makeLines(651));
    const grown = checkCodeHealth(root);
    assert.equal(grown.ok, false);
    assert.equal(grown.violations[0].rule, 'monolith-ratchet');
    assert.match(grown.violations[0].message, /\+1 line/);

    const refused = applyRatchet(root);
    assert.equal(refused.ok, false);
    assert.equal(refused.blockedIncreases.length, 1);
    const unchanged = JSON.parse(readFileSync(join(root, 'scripts/code-health-baseline.json'), 'utf8'));
    assert.equal(unchanged.monolithMaxLines['apps/kiki-gui/src/components/LegacyMonolith.tsx'], 650);

    writeFixture(root, 'apps/kiki-gui/src/components/LegacyMonolith.tsx', makeLines(620));
    const shrunk = checkCodeHealth(root);
    assert.equal(shrunk.ok, true);
    assert.equal(shrunk.ratchetSavings.monolithShrinks.length, 1);

    const tightened = applyRatchet(root);
    assert.equal(tightened.ok, true);
    const updated = JSON.parse(readFileSync(join(root, 'scripts/code-health-baseline.json'), 'utf8'));
    assert.equal(updated.monolithMaxLines['apps/kiki-gui/src/components/LegacyMonolith.tsx'], 620);

    writeFixture(root, 'apps/kiki-gui/src/components/LegacyMonolith.tsx', makeLines(550));
    const lowered = applyRatchet(root);
    assert.equal(lowered.ok, true);
    assert.equal(lowered.nextBaseline.monolithMaxLines['apps/kiki-gui/src/components/LegacyMonolith.tsx'], 550);
  });

  it('allows explicit --allow-baseline-increase only with a non-empty reason', () => {
    const root = createFixtureRepo({
      monolithMaxLines: {
        'apps/kiki-gui/src/components/LegacyMonolith.tsx': 650,
      },
    });
    writeFixture(root, 'apps/kiki-gui/src/components/LegacyMonolith.tsx', makeLines(660));
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT_PATH, '--root', root, '--ratchet', '--allow-baseline-increase'], {
        stdio: 'pipe',
      });
    });

    execFileSync(
      process.execPath,
      [SCRIPT_PATH, '--root', root, '--ratchet', '--allow-baseline-increase', 'approved test migration'],
      { stdio: 'pipe' },
    );
    const updated = JSON.parse(readFileSync(join(root, 'scripts/code-health-baseline.json'), 'utf8'));
    assert.equal(updated.monolithMaxLines['apps/kiki-gui/src/components/LegacyMonolith.tsx'], 660);
  });

  it('blocks new relative internal vi.mock calls while allowing spy-only mocks and external mocks', () => {
    const mockCall = ['vi', 'mock'].join('.');
    const root = createFixtureRepo({
      internalTestMocks: {
        'apps/kiki-gui/src/components/Existing.test.tsx': 1,
      },
    });
    writeFixture(
      root,
      'apps/kiki-gui/src/components/Existing.test.tsx',
      `${mockCall}('../Transcript', () => ({ Transcript: () => null }));\n${mockCall}('lucide-react', () => ({}));\n`,
    );
    writeFixture(
      root,
      'apps/kiki-gui/src/components/SpyOnly.test.tsx',
      `${mockCall}('../Transcript', { spy: true });\n`,
    );
    assert.equal(checkCodeHealth(root).ok, true);

    writeFixture(
      root,
      'apps/kiki-gui/src/components/NewShortcut.test.tsx',
      `${mockCall}('../foo', () => ({ foo: () => 1 }));\n`,
    );
    const report = checkCodeHealth(root);
    assert.equal(report.ok, false);
    const v = report.violations.find((item) => item.rule === 'internal-test-mock-ratchet');
    assert.ok(v, 'expected internal-test-mock-ratchet violation');
    assert.equal(v.file, 'apps/kiki-gui/src/components/NewShortcut.test.tsx');
    assert.match(v.fix, /boundary adapter|real production wiring/i);
  });

  it('blocks native browser dialogs, banned defensive copy, and decorative UI emojis', () => {
    const root = createFixtureRepo();
    writeFixture(
      root,
      'apps/kiki-gui/src/components/BadDialog.tsx',
      "export function BadDialog() { if (window.confirm('delete?')) return <span>🚀 数据可能已过期</span>; return null; }\n",
    );
    writeFixture(
      root,
      'packages/session-core/src/i18n/domains/en/test.ts',
      "export const copy = { warn: 'Results may be incomplete' };\n",
    );
    const report = checkCodeHealth(root);
    assert.equal(report.ok, false);
    const rules = new Set(report.violations.map((v) => v.rule));
    assert.ok(rules.has('gui-native-dialog'));
    assert.ok(rules.has('gui-banned-defensive-copy'));
    assert.ok(rules.has('gui-decorative-emoji'));
    assert.ok(
      report.violations.some((v) => v.file === 'packages/session-core/src/i18n/domains/en/test.ts'),
      'expected session-core i18n banned copy to be caught',
    );
  });

  it('blocks bare crypto.randomUUID() in client packages while allowing optional-chained or getRandomValues helpers', () => {
    const root = createFixtureRepo();
    writeFixture(
      root,
      'apps/kiki-gui/src/lib/safeUuid.ts',
      'export function safeUuid() { return globalThis.crypto?.randomUUID?.() ?? String(crypto.getRandomValues(new Uint8Array(16))[0]); }\n',
    );
    assert.equal(checkCodeHealth(root).ok, true);

    writeFixture(
      root,
      'apps/kiki-gui/src/lib/unsafeGuiUuid.ts',
      'export const id = () => crypto.randomUUID();\n',
    );
    writeFixture(
      root,
      'packages/session-core/src/util/unsafeCoreUuid.ts',
      'export const id = () => globalThis.crypto.randomUUID();\n',
    );
    const report = checkCodeHealth(root);
    assert.equal(report.ok, false);
    const uuidViolations = report.violations.filter((v) => v.rule === 'client-bare-random-uuid');
    assert.equal(uuidViolations.length, 2);
  });

  it('catches broken backticked package-relative and repo-relative paths in AGENTS.md', () => {
    const root = createFixtureRepo();
    writeFixture(
      root,
      'apps/kiki-gui/AGENTS.md',
      [
        '# GUI',
        '',
        '- Real: `src/components/CleanView.tsx`',
        '- Broken pkg-relative: `src/components/DoesNotExist.tsx`',
        '- Broken repo-relative: `packages/session-core/src/missing.ts`',
        '- Explicit negative: `src/legacy/` does not exist in this tree.',
        '',
      ].join('\n'),
    );
    const report = checkCodeHealth(root);
    assert.equal(report.ok, false);
    const linkViolations = report.violations.filter((v) => v.rule === 'catalog-link-integrity');
    assert.equal(linkViolations.length, 2);
    assert.match(linkViolations[0].message, /src\/components\/DoesNotExist\.tsx/);
    assert.match(linkViolations[1].message, /packages\/session-core\/src\/missing\.ts/);
  });
});

const BASELINE = 'scripts/code-health-baseline.json';

function updateFixtureBaseline(root, update) {
  const current = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  update(current);
  writeFixture(root, BASELINE, `${JSON.stringify(current, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=.git/test-hooks', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFixture(root, message) {
  git(root, 'add', '--', BASELINE);
  git(root, '-c', 'user.name=Code Health Test', '-c', 'user.email=fixture@example.test', 'commit', '-m', message);
}

it('checks committed baseline inflation against a real PR merge base, not HEAD or the base tip', () => {
  const legacy = 'packages/example/src/Legacy.ts';
  const tightened = 'packages/example/src/Tightened.ts';
  const oldMock = 'packages/example/test/Old.test.ts';
  const newMock = 'packages/example/test/New.integration.ts';
  const root = createFixtureRepo({
    maxNewFileLines: 500,
    monolithMaxLines: { [legacy]: 620, [tightened]: 480 },
    internalTestMocks: { [oldMock]: 1 },
  });
  git(root, 'init', '-b', 'release-base');
  commitFixture(root, 'Freeze prior allowances');
  git(root, 'switch', '-c', 'candidate');
  updateFixtureBaseline(root, (baseline) => {
    baseline.monolithMaxLines[legacy] = 621;
    delete baseline.monolithMaxLines[tightened];
    baseline.monolithMaxLines['packages/example/src/Big.cts'] = 601;
    baseline.internalTestMocks[oldMock] = 2;
    baseline.internalTestMocks[newMock] = 1;
  });
  commitFixture(root, 'Raise allowances on candidate');
  git(root, 'switch', 'release-base');
  updateFixtureBaseline(root, (baseline) => { baseline.monolithMaxLines[legacy] = 610; });
  commitFixture(root, 'Independently tighten the base tip');
  git(root, 'update-ref', 'refs/remotes/origin/release-base', 'HEAD');
  git(root, 'switch', 'candidate');

  assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH, '--root', root], {
    stdio: 'pipe', env: { ...process.env, KIKI_DIFF_BASE: '', GITHUB_BASE_REF: 'release-base' },
  }), (error) => {
    const stderr = String(error.stderr);
    assert.match(stderr, /Legacy\.ts increased from 620 to 621/u);
    assert.match(stderr, /Tightened\.ts increased from 480 to 500/u);
    assert.match(stderr, /Big\.cts increased from 500 to 601/u);
    assert.match(stderr, /Old\.test\.ts increased from 1 to 2/u);
    assert.match(stderr, /New\.integration\.ts increased from 0 to 1/u);
    return error.status === 1;
  });
});

it('accepts a downward edit against an explicit baseline and rejects new exceptions above a lowered ceiling', () => {
  const legacy = 'packages/example/src/legacy.ts';
  const root = createFixtureRepo({ maxNewFileLines: 600, monolithMaxLines: { [legacy]: 620 } });
  const base = join(root, 'prior.json');
  writeFixture(root, 'prior.json', readFileSync(join(root, BASELINE), 'utf8'));
  updateFixtureBaseline(root, (baseline) => {
    baseline.maxNewFileLines = 500;
    baseline.monolithMaxLines[legacy] = 550;
  });
  assert.equal(checkCodeHealth(root, { baseBaselinePath: base }).ok, true);
  updateFixtureBaseline(root, (baseline) => { baseline.monolithMaxLines['packages/example/src/new.ts'] = 550; });
  assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH, '--root', root, '--base-baseline', base], {
    stdio: 'pipe',
  }), (error) => /new\.ts increased from 500 to 550/u.test(String(error.stderr)));
});

it('keeps a tracked cap after shrinking below the default ceiling and rejects regrowth from both sides of it', () => {
  const legacy = 'packages/example/src/legacy.ts';
  const root = createFixtureRepo({ maxNewFileLines: 500, monolithMaxLines: { [legacy]: 620 } });
  for (const count of [550, 480]) {
    writeFixture(root, legacy, makeLines(count));
    const outcome = applyRatchet(root);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.nextBaseline.monolithMaxLines[legacy], count);
    writeFixture(root, legacy, makeLines(count + 1));
    assert.equal(checkCodeHealth(root).violations[0].rule, 'monolith-ratchet');
  }
});

it('counts .mts and .cts source even under src/build, but excludes package build output and declarations', () => {
  const root = createFixtureRepo();
  const rejected = ['packages/example/src/tool.mts', 'apps/example/src/build/nested/tool.cts'];
  for (const file of [...rejected, 'apps/example/build/generated.ts', 'packages/example/src/api.d.mts', 'packages/example/src/api.d.cts']) {
    writeFixture(root, file, makeLines(601));
  }
  assert.deepEqual(checkCodeHealth(root).violations.map(({ file }) => file), rejected.toSorted());
});

it('checks split and commented vi mock/doMock calls in both integration test extensions', () => {
  const root = createFixtureRepo();
  const [vi, mock, doMock] = ['vi', 'mock', 'doMock'];
  const files = ['packages/example/test/work.integration.ts', 'apps/example/test/view.integration.tsx'];
  writeFixture(root, files[0], `// ${vi}.${mock}('./ignored');\n${vi} /* split */ .\n  ${mock}\n  ('../service');`);
  writeFixture(root, files[1], `${vi} // split\n. ${doMock} /* split */\n ('./view');\n${vi}\n. ${mock}('./view', { spy: true });`);
  const { violations } = checkCodeHealth(root);
  assert.deepEqual(violations.map(({ rule, file, line }) => [rule, file, line]), [
    ['internal-test-mock-ratchet', files[1], 1],
    ['internal-test-mock-ratchet', files[0], 2],
  ]);
});

it('checks top-level GUI copy, emoji and native dialogs across comments and newlines', () => {
  const root = createFixtureRepo();
  writeFixture(root, 'apps/kiki-gui/src/App.tsx', [
    '// window.alert("ignore");', 'window /* split */ .\nalert\n("bad");', 'confirm\n("bad");',
    'prompt /* split */ ("bad");', "export const App = () => <div>Data{' '}may {/* split */}\nbe stale 🚀</div>;",
  ].join('\n'));
  writeFixture(root, 'apps/kiki-gui/src/ShellEntry.ts', 'export const copy = `结果可能\n  不完整`;');
  assert.deepEqual(checkCodeHealth(root).violations.map(({ rule, line }) => [rule, line]), [
    ['gui-native-dialog', 2], ['gui-native-dialog', 5], ['gui-native-dialog', 7],
    ['gui-banned-defensive-copy', 8], ['gui-decorative-emoji', 9], ['gui-banned-defensive-copy', 1],
  ]);
});

it('checks unguarded UUID calls in the mobile launcher and does not treat an unrelated typeof as a guard', () => {
  const root = createFixtureRepo();
  const launcher = 'apps/kiki-gui/mobile/src/launcher.ts';
  writeFixture(root, launcher, [
    'export function safe() {',
    "  if (typeof globalThis.crypto?.randomUUID === 'function') {",
    '    return globalThis.crypto /* split */ .\n randomUUID();',
    '  }', '  return String(crypto.getRandomValues(new Uint8Array(16))[0]);', '}',
  ].join('\n'));
  assert.equal(checkCodeHealth(root).ok, true);
  writeFixture(root, launcher, [
    '// crypto.randomUUID();', "const supported = typeof crypto.randomUUID === 'function';",
    'export const unguarded = () => crypto /* split */ .\n randomUUID /* split */\n ();',
  ].join('\n'));
  const { violations } = checkCodeHealth(root);
  assert.deepEqual(violations.map(({ rule, file, line }) => [rule, file, line]), [
    ['client-bare-random-uuid', launcher, 3],
  ]);
});

it('resolves POSIX catalog locations with line/column anchors and refuses cross-root src fallbacks or backslashes', () => {
  const root = createFixtureRepo();
  writeFixture(root, 'src/wrong.ts', '');
  writeFixture(root, 'apps/kiki-gui/wrong.ts', '');
  writeFixture(root, 'apps/kiki-gui/src/AGENTS.md', [
    '`./components/CleanView.tsx:1:2#heading`',
    '`../AGENTS.md#gui`',
    '`apps/kiki-gui/src/components/CleanView.tsx:1`',
    '`./missing.ts:1`',
    '`../missing.ts#heading`',
  ].join('\n'));
  writeFixture(root, 'apps/kiki-gui/AGENTS.md', [
    '`src/wrong.ts`',
    '`src/../wrong.ts`',
    '`src\\components\\CleanView.tsx`',
    '`./src\\components/CleanView.tsx:1`',
  ].join('\n'));
  assert.deepEqual(checkCodeHealth(root).violations.map(({ rule, line }) => [rule, line]), [
    ['catalog-link-integrity', 1], ['catalog-link-integrity', 2],
    ['catalog-link-integrity', 3], ['catalog-link-integrity', 4],
    ['catalog-link-integrity', 4], ['catalog-link-integrity', 5],
  ]);
});
