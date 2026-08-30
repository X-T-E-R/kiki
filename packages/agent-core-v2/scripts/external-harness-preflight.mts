import {
  bootstrap,
  IAgentExecutorPreflightService,
  logSeed,
  resolveBootstrapOptions,
  resolveLoggingConfig,
} from '../src/index.ts';

const args = new Set(process.argv.slice(2));
const json = args.delete('--json');
const strict = args.delete('--strict');
const ids = [...args].filter((value) => !value.startsWith('--'));
const input = {
  configReadOnly: true,
  clientIdentity: {
    productName: 'kiki-external-harness-preflight',
    version: '0',
    platform: process.platform,
  },
};
const options = resolveBootstrapOptions(input);
const { app } = bootstrap(
  input,
  logSeed(resolveLoggingConfig({ homeDir: options.homeDir, env: process.env })),
);

try {
  const results = await app.accessor
    .get(IAgentExecutorPreflightService)
    .run(ids.length === 0 ? undefined : ids);
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.id}: ${result.status}\n`);
      process.stdout.write(`  command: ${result.command}${result.resolvedArgs.length === 0 ? '' : ` ${result.resolvedArgs.join(' ')}`}\n`);
      if (result.version !== undefined) process.stdout.write(`  version: ${result.version}\n`);
      for (const diagnostic of result.diagnostics) {
        process.stdout.write(`  ${diagnostic.severity}: ${diagnostic.message}\n`);
      }
    }
  }
  if (strict && results.some((result) => result.status === 'unavailable')) process.exitCode = 1;
} finally {
  app.dispose();
}

process.exit(process.exitCode ?? 0);
