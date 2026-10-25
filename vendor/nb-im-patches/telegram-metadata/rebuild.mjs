import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const patchDir = import.meta.dirname;
const root = resolve(patchDir, '../../..');
await mkdir(join(root, '.tmp'), { recursive: true });
const scratch = await mkdtemp(join(root, '.tmp', 'nb-im-metadata-rebuild-'));
const archive = join(scratch, 'nb-im-core-0.3.0-kiki-im-metadata.tgz');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const local = (path) => relative(root, path).replaceAll('\\', '/');
run('tar', ['-xf', 'vendor/nb-im-core-0.3.0.tgz', '-C', local(scratch)]);
run('git', ['apply', '--unidiff-zero', `--directory=${relative(root, join(scratch, 'package')).replaceAll('\\', '/')}`, join(patchDir, 'source.patch')]);
await writeFile(join(scratch, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    declaration: true, declarationMap: false, sourceMap: false, rewriteRelativeImportExtensions: true,
    verbatimModuleSyntax: true, typeRoots: [join(root, 'node_modules/@types')], types: ['node'],
    skipLibCheck: true, noEmitOnError: true, outDir: './generated', rootDir: './package/src',
  },
  files: ['./package/src/session/contract.ts', './package/src/session/telegram.ts'],
}, null, 2));
run(process.execPath, [join(root, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json')]);
for (const module of ['contract', 'telegram']) {
  for (const extension of ['js', 'd.ts']) await copyFile(join(scratch, `generated/session/${module}.${extension}`), join(scratch, `package/dist/session/${module}.${extension}`));
}
run(process.execPath, ['--test', '--experimental-strip-types', 'test/session-telegram.test.ts'], join(scratch, 'package'));
run('tar', ['-czf', local(archive), '-C', local(scratch), 'package']);
process.stdout.write(`${archive}\n`);
