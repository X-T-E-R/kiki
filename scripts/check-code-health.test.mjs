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
    const cleared = applyRatchet(root);
    assert.equal(cleared.ok, true);
    const finalBaseline = JSON.parse(readFileSync(join(root, 'scripts/code-health-baseline.json'), 'utf8'));
    assert.equal(finalBaseline.monolithMaxLines['apps/kiki-gui/src/components/LegacyMonolith.tsx'], undefined);
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
