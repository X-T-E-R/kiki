delete process.env['KIKI_EXPERIMENTAL_FLAG'];
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIKI_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

process.env['KIKI_EXPERIMENTAL_SEARCH_WORKER'] = 'false';

process.env['KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL'] = 'false';
