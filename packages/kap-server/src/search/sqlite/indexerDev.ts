let booting = true;
process.on('message', (message: unknown) => {
  if (!booting || message === null || typeof message !== 'object' || !('type' in message) || message.type !== 'close') return;
  process.exit(0);
});
await new Promise<void>((resolve) => { setImmediate(resolve); });

try {
  const loaded = await import('./indexerEntry');
  booting = false;
  await loaded.runSqliteIndexerCommand(process.argv[2] ?? '');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
process.exit(0);
