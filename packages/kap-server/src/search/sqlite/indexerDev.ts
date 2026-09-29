import { runSqliteIndexerCommand } from './indexerEntry';

await runSqliteIndexerCommand(process.argv[2] ?? '');
process.exit(0);
