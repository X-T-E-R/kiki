import { kikiMcpConfigFromEnv, runKikiMcpStdio } from '@kiki/kap-server';

process.title = 'kiki';

void (async () => {
  try {
    await runKikiMcpStdio(kikiMcpConfigFromEnv(process.env));
    process.exit(0);
  } catch (error) {
    const code = process.exitCode;
    if (typeof code !== 'number' || code <= 0) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.exit(code);
  }
})();
