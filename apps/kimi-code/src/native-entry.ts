import { mcpModeError, type McpModeOptions } from './kiki/mcpMode';

function commandArguments(argv: readonly string[]): readonly string[] {
  const second = argv[1];
  const script = second !== undefined && (second.includes('/') || second.includes('\\') || /\.(?:cjs|mjs|js|ts)$/.test(second));
  return argv.slice(script ? 2 : 1);
}

function attachedMcpDecision(argv: readonly string[]): { readonly kind: 'attached' } | { readonly kind: 'main' } | { readonly kind: 'error'; readonly message: string } {
  if (argv.includes('-p') || argv.includes('--prompt') || argv.includes('--prompt-file')) return { kind: 'main' };
  const args = commandArguments(argv);
  if (args[0] !== 'mcp') return { kind: 'main' };
  const mode: { attached: boolean; tools: boolean; client?: string; workspace?: string } = { attached: false, tools: false };
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--attached') {
      mode.attached = true;
      continue;
    }
    if (token === '--tools') {
      mode.tools = true;
      continue;
    }
    if (token === '--help' || token === '-h' || token === '--') return { kind: 'main' };
    const separator = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = separator === -1 ? token : token.slice(0, separator);
    if (name !== '--workspace' && name !== '--home' && name !== '--client') return { kind: 'main' };
    const inline = separator !== -1;
    const value = inline ? token.slice(separator + 1) : args[index + 1];
    if (!inline) {
      if (value === undefined) return { kind: 'main' };
      index += 1;
    }
    if (name === '--client') mode.client = value;
    else if (name === '--workspace') mode.workspace = value;
  }
  const options: McpModeOptions = {
    attached: mode.attached,
    tools: mode.tools,
    client: mode.client,
    workspace: mode.workspace,
  };
  const message = mcpModeError(options);
  if (message !== undefined) return { kind: 'error', message };
  return mode.attached ? { kind: 'attached' } : { kind: 'main' };
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
} else {
  const decision = attachedMcpDecision(process.argv);
  if (decision.kind === 'error') {
    process.stderr.write(`${decision.message}\n`);
    process.exit(1);
  } else if (decision.kind === 'attached') {
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
}

export {};
