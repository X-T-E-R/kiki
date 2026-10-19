/**
 * Locate the compiled GUI stylesheet a visual proof paints with.
 *
 * The lookup fails instead of returning "not found": a proof that cannot find
 * the build must say so loudly. A silently skipped screenshot asserts nothing
 * about the colours it was written to check.
 *
 * Test-only. The two proof suites that paint in Chromium share this so the
 * "missing directory" and "directory without CSS" cases are decided in one
 * place and can be exercised without starting a browser.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface CompiledGuiStylesheet {
  /** The `assets` directory the CSS came from. */
  readonly dir: string;
  /** Absolute path of the hashed `index-*.css`. */
  readonly cssPath: string;
}

export function resolveCompiledGuiStylesheet(cwd: string = process.cwd()): CompiledGuiStylesheet {
  const dir = [join(cwd, 'dist', 'assets'), join(cwd, 'apps', 'kiki-gui', 'dist', 'assets')]
    .find((candidate) => existsSync(candidate));
  if (dir === undefined) {
    throw new Error('compiled gui stylesheet is missing: build the GUI before running this proof');
  }
  const cssName = readdirSync(dir).find((name) => name.startsWith('index-') && name.endsWith('.css'));
  if (cssName === undefined) {
    throw new Error(`no compiled stylesheet in ${dir}: build the GUI before running this proof`);
  }
  return { dir, cssPath: join(dir, cssName) };
}
