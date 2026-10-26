import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { createMailboxMigrationService } from '#/persistence/backends/sqliteMailbox/migration';
import { migrationPath } from '#/persistence/backends/sqliteMailbox/authority';
import { CanonicalMailboxDatabase } from '#/persistence/backends/sqliteMailbox/database';

const [home = '', boundary = 'importing'] = process.argv.slice(2);
const service = createMailboxMigrationService(home);
if (boundary === 'rollback-authority') {
  const original = CanonicalMailboxDatabase.prototype.metadata;
  CanonicalMailboxDatabase.prototype.metadata = async function<T>(key: string, value?: T): Promise<T | undefined> {
    const result = await original.call(this, key, value) as T | undefined;
    if (key === 'authority' && value === 'rolled_back') {
      writeSync(1, `${JSON.stringify({ boundary })}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  };
  await service.rollback();
  throw new Error('Expected crash after rollback SQLite authority commit');
}
let seenSwitch = false;
const result = await service.migrate({ onProgress: (status) => {
  const stop = boundary === 'importing' && status.phase === 'importing' && status.progress.items > 0
    || boundary === 'switching' && status.phase === 'switching'
    || boundary === 'fenced' && status.phase === 'switching' && seenSwitch
    || boundary === 'complete' && status.phase === 'complete';
  if (status.phase === 'switching') seenSwitch = true;
  if (stop) {
    writeSync(1, `${JSON.stringify({ boundary, status })}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
} });
await service.close();
writeSync(2, `${JSON.stringify({ unexpectedCompletion: result, checkpoint: await readFile(migrationPath(home), 'utf8') })}\n`);
process.exitCode = 1;
