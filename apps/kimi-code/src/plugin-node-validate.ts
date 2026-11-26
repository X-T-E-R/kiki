import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, parseArgs } from 'node:util';
import vm from 'node:vm';

export async function validatePluginNodeEntry(
  entry: string,
  args: readonly string[],
  pluginRoot: string,
  trustedRunner: string | null = null,
): Promise<{ entryReal: string; argsReal: readonly string[] }> {
  const [rootReal, entryReal] = await Promise.all([realpath(pluginRoot), realpath(entry)]);
  if (isWithin(entryReal, rootReal)) return { entryReal, argsReal: args };
  if (trustedRunner !== null && args.length === 1) {
    const runnerReal = await realpath(trustedRunner).catch(() => null);
    if (runnerReal !== null && entryReal === runnerReal) {
      const targetReal = await realpath(args[0]!);
      if (isWithin(targetReal, rootReal)) {
        return { entryReal, argsReal: [targetReal] };
      }
    }
  }
  throw new Error(`Plugin node entry must be inside KIKI_PLUGIN_ROOT: ${entry}`);
}

export async function executePluginNodeEntry(
  entry: string,
  args: readonly string[],
  trustedRunner: string | null = null,
): Promise<void> {
  const pluginRoot = process.env['KIKI_PLUGIN_ROOT'];
  const hasPluginRoot = pluginRoot !== undefined && pluginRoot.trim().length > 0;
  if (process.env['KIKI_NODE_SHIM'] === '1') {
    const rawArgs = entry === '' && args.length === 0 ? [] : [entry, ...args];
    await executeNodeShim(rawArgs, hasPluginRoot ? pluginRoot : null, trustedRunner);
    return;
  }
  if (!hasPluginRoot) {
    throw new Error('KIKI_PLUGIN_ROOT is required to run a plugin node entry.');
  }

  const { entryReal, argsReal } = await validatePluginNodeEntry(
    entry,
    args,
    pluginRoot,
    trustedRunner,
  );
  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...argsReal];
  armPluginStdinExitGuard();
  await dynamicImportDiskModule(pathToFileURL(entryReal).href);
}

function armPluginStdinExitGuard(): void {
  process.stdin.once('end', () => {
    const timer = setTimeout(() => process.exit(0), 1_000);
    timer.unref();
  });
}

async function dynamicImportDiskModule(specifier: string): Promise<unknown> {
  // Keep disk ESM/TLA loading outside the native bundle's dynamic-import-to-require transform.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const importModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>;
  return importModule(specifier);
}

type ParsedNodeShimArgs =
  | { kind: 'version' }
  | {
      kind: 'eval';
      code: string;
      printResult: boolean;
      inputType: 'module' | 'commonjs' | undefined;
      restArgs: readonly string[];
    }
  | { kind: 'script'; scriptPath: string; restArgs: readonly string[] };

function parseNodeShimArgs(rawArgs: readonly string[]): ParsedNodeShimArgs {
  const normalized = rawArgs.map((arg) => (arg === '-pe' || arg === '-ep' ? '-p' : arg));
  const { tokens } = parseArgs({
    args: normalized,
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      version: { type: 'boolean', short: 'v' },
      eval: { type: 'string', short: 'e' },
      print: { type: 'string', short: 'p' },
      'input-type': { type: 'string' },
    },
  });

  let inputType: 'module' | 'commonjs' | undefined;
  for (const token of tokens) {
    if (token.kind === 'option-terminator') {
      const scriptPath = normalized[token.index + 1];
      if (scriptPath === undefined || scriptPath.trim().length === 0) break;
      return { kind: 'script', scriptPath, restArgs: normalized.slice(token.index + 2) };
    }
    if (token.kind === 'positional') {
      return {
        kind: 'script',
        scriptPath: token.value,
        restArgs: normalized.slice(token.index + 1),
      };
    }
    if (token.name === 'version') {
      return { kind: 'version' };
    }
    if (token.name === 'input-type' && (token.value === 'module' || token.value === 'commonjs')) {
      inputType = token.value;
      continue;
    }
    if (token.name === 'eval' || token.name === 'print') {
      const consumedInline = token.inlineValue === true;
      const afterEvalIndex = consumedInline ? token.index + 1 : token.index + 2;
      const tail = normalized.slice(afterEvalIndex);
      const restArgs = tail[0] === '--' ? tail.slice(1) : tail;
      return {
        kind: 'eval',
        code: typeof token.value === 'string' ? token.value : '',
        printResult: token.name === 'print',
        inputType,
        restArgs,
      };
    }
  }
  throw new Error('Node shim requires a script file or --eval / --print expression.');
}

async function executeNodeShim(
  rawArgs: readonly string[],
  pluginRoot: string | null,
  trustedRunner: string | null,
): Promise<void> {
  const parsed = parseNodeShimArgs(rawArgs);
  if (parsed.kind === 'version') {
    process.stdout.write(`${process.version}\n`);
    return;
  }

  const execZero = process.argv[0] ?? process.execPath;
  if (pluginRoot !== null) {
    armPluginStdinExitGuard();
  }

  if (parsed.kind === 'eval') {
    if (pluginRoot !== null) {
      throw new Error('Plugin node entry must be a script inside KIKI_PLUGIN_ROOT.');
    }
    process.argv = [execZero, ...parsed.restArgs];
    if (parsed.inputType === 'module') {
      const encoded = Buffer.from(parsed.code, 'utf8').toString('base64');
      await dynamicImportDiskModule(`data:text/javascript;base64,${encoded}`);
      return;
    }
    const evalFilename = path.join(process.cwd(), '[eval]');
    const evalRequire = createRequire(`${evalFilename}.cjs`);
    const evalModule = { exports: {} as unknown };
    const globals = globalThis as Record<string, unknown>;
    globals['require'] = evalRequire;
    globals['__filename'] = '[eval]';
    globals['__dirname'] = process.cwd();
    globals['module'] = evalModule;
    globals['exports'] = evalModule.exports;
    const outcome = vm.runInThisContext(parsed.code, { filename: '[eval]' });
    if (parsed.printResult) {
      const resolved = outcome instanceof Promise ? await outcome : outcome;
      process.stdout.write(`${typeof resolved === 'string' ? resolved : inspect(resolved)}\n`);
    }
    return;
  }

  let scriptReal: string;
  let scriptArgs: readonly string[];
  if (pluginRoot !== null) {
    const validated = await validatePluginNodeEntry(
      parsed.scriptPath,
      parsed.restArgs,
      pluginRoot,
      trustedRunner,
    );
    scriptReal = validated.entryReal;
    scriptArgs = validated.argsReal;
  } else {
    scriptReal = await realpath(path.resolve(process.cwd(), parsed.scriptPath));
    scriptArgs = parsed.restArgs;
  }
  process.argv = [execZero, scriptReal, ...scriptArgs];
  if (scriptReal.toLowerCase().endsWith('.cjs')) {
    createRequire(scriptReal)(scriptReal);
    return;
  }
  await dynamicImportDiskModule(pathToFileURL(scriptReal).href);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
