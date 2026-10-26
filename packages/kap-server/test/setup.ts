delete process.env['KIKI_DESKTOP_BUNDLED'];
delete process.env['KIKI_EXPERIMENTAL_FLAG'];
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIKI_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

delete process.env['KIKI_SQLITE_QUERY_WORKER_PATH'];
delete process.env['KIKI_SQLITE_INDEXER_PATH'];

process.env['KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL'] = 'false';
