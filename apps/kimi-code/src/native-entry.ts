function attachedMcpCommand(argv: readonly string[]): boolean {
  if (argv.includes('-p') || argv.includes('--prompt') || argv.includes('--prompt-file')) return false;
  const mcp = argv.findIndex((arg, index) => index > 0 && arg === 'mcp');
  return mcp > 0 && argv.slice(mcp + 1).includes('--attached');
}

const indexerArg = process.argv.findIndex((arg, index) => index > 0 && arg === '__search-indexer');

if (indexerArg > 0) {
  void import('@kiki/kap-server/sqlite-indexer-runtime')
    .then(({ runSqliteIndexerCommand }) => runSqliteIndexerCommand(process.argv[indexerArg + 1] ?? ''))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
} else if (attachedMcpCommand(process.argv)) {
  void import('./mcp-sea-entry').catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  void import('./main').catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export {};
