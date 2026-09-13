import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { migrateLegacyKikiConfiguration, migrateLegacyKikiProject, resolveKikiHome } from '@kiki/oauth';

export function registerMigrationCommand(program: Command): void {
  program.command('migrate-config')
    .description('Copy legacy configuration and authored assets once; never overwrite Kiki files.')
    .option('--from <directory>', 'Legacy home directory (KIMI_CODE_HOME is accepted only here).')
    .option('--home <directory>', 'Destination Kiki home directory.')
    .option('--workspace <directory>', 'Migrate this project .kimi-code directory to .kiki instead of the user home.')
    .option('--json', 'Print the migration result as JSON.')
    .action((options: { from?: string; home?: string; workspace?: string; json?: boolean }) => {
      if (options.workspace !== undefined && (options.from !== undefined || options.home !== undefined)) throw new Error('--workspace cannot be combined with --from or --home.');
      const result = options.workspace === undefined
        ? migrateLegacyKikiConfiguration(options.from ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code'), resolveKikiHome(options.home))
        : migrateLegacyKikiProject(options.workspace);
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Configuration migration: ${result.status}; copied ${result.copied.length}, preserved ${result.preserved.length}.\n`);
      if (result.status === 'incomplete') {
        process.stderr.write(`Unmigrated assets: ${JSON.stringify(result.unmigrated)}. Review their configuration references and copy required assets explicitly before retrying.\n`);
        process.exitCode = 2;
      }
    });
}
