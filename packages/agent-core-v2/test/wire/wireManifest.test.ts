import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { MANIFEST_PATH } from '../../scripts/gen-wire-manifest.mts';

describe('wire manifest', () => {
  it('docs/wire-manifest.d.ts is up to date', () => {
    const loader = new URL('../../../../build/register-raw-text-loader.mjs', import.meta.url).href;
    const generator = fileURLToPath(new URL('../../scripts/gen-wire-manifest.mts', import.meta.url));
    execFileSync(process.execPath, ['--import', 'tsx', '--import', loader, generator, '--check'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60_000, windowsHide: true,
    });
  }, 65_000);

  it('docs/wire-manifest.d.ts parses as TypeScript', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'wire-manifest.d.ts',
      readFileSync(MANIFEST_PATH, 'utf-8'),
    );
    const diagnostics = (sourceFile.compilerNode as { parseDiagnostics?: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics ?? []).toEqual([]);
  });
});
