const banner = process.env['KIKI_TEST_MCP_STDERR'] ?? 'fatal: missing API token';
process.stderr.write(`${banner}\n`);
process.exit(2);
