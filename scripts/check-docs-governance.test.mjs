import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { checkDocsGovernance } from './check-docs-governance.mjs';

const skillRoot = '.agents/skills/kiki-docs-catchup';

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'docs-governance-'));
  const index = '# Home\n\n## Start\n\nRead the [guide](./guide.md).\n';
  const guide = '# Guide\n\n```md\n### Not a heading\n[not a link](./missing.md)\n```\n\n## Use it\n';
  write(root, 'docs/en/index.md', index);
  write(root, 'docs/zh/index.md', index);
  write(root, 'docs/en/guide.md', guide);
  write(root, 'docs/zh/guide.md', guide);
  write(
    root,
    'docs/.vitepress/config.ts',
    "export default { locales: { en: { nav: [{ link: '/en/guide' }] }, zh: { nav: [{ link: '/zh/guide' }] } } };\n",
  );
  write(
    root,
    `${skillRoot}/SKILL.md`,
    [
      '---',
      'name: kiki-docs-catchup',
      'description: Catch documentation up after implementation.',
      '---',
      '',
      '# Catch up',
      '',
      'Read [the trigger matrix](references/trigger-matrix.md).',
      'Use [the semantic packet](references/semantic-packet.md).',
      'Freeze [the mechanical packet](references/mechanical-packet.md).',
      '',
    ].join('\n'),
  );
  write(root, `${skillRoot}/agents/openai.yaml`, 'interface:\n  display_name: "Kiki Docs Catch-up"\n');
  write(root, `${skillRoot}/references/trigger-matrix.md`, '# Trigger matrix\n');
  write(root, `${skillRoot}/references/semantic-packet.md`, '# Semantic packet\n');
  write(root, `${skillRoot}/references/mechanical-packet.md`, '# Mechanical packet\n');
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function codes(root) {
  return checkDocsGovernance(root).map((error) => error.code);
}

void test('accepts a structurally consistent fixture without making semantic claims', () => {
  withFixture((root) => assert.deepEqual(checkDocsGovernance(root), []));
});

void test('detects a missing locale mirror', () => {
  withFixture((root) => {
    rmSync(join(root, 'docs/zh/guide.md'));
    assert.ok(codes(root).includes('mirror-missing'));
  });
});

void test('detects heading-level drift outside fenced code', () => {
  withFixture((root) => {
    write(root, 'docs/zh/guide.md', '# Guide\n\n### Use it\n');
    assert.ok(codes(root).includes('heading-structure'));
  });
});

void test('detects an unresolved locale navigation target', () => {
  withFixture((root) => {
    write(root, 'docs/.vitepress/config.ts', "export default { link: '/en/missing-page' };\n");
    assert.ok(codes(root).includes('nav-target'));
  });
});

void test('detects locale navigation set drift even when every target page exists', () => {
  withFixture((root) => {
    write(
      root,
      'docs/.vitepress/config.ts',
      "export default { locales: { en: { nav: [{ link: '/en/guide' }] }, zh: { nav: [{ link: '/zh/' }] } } };\n",
    );
    const result = codes(root);
    assert.ok(result.includes('nav-mirror'));
    assert.ok(!result.includes('nav-target'));
  });
});

void test('detects an unresolved relative Markdown link', () => {
  withFixture((root) => {
    write(root, 'docs/en/index.md', '# Home\n\n## Start\n\nRead [missing](./missing.md).\n');
    assert.ok(codes(root).includes('relative-link'));
  });
});

void test('detects a missing required skill resource', () => {
  withFixture((root) => {
    rmSync(join(root, `${skillRoot}/references/mechanical-packet.md`));
    assert.ok(codes(root).includes('required-resource'));
  });
});

void test('detects missing skill frontmatter', () => {
  withFixture((root) => {
    write(root, `${skillRoot}/SKILL.md`, '# Catch up\n');
    assert.ok(codes(root).includes('skill-frontmatter'));
  });
});
