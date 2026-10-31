import { open, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { createKlient } from '@kiki/klient/http';
import type { ExternalClientResultRange } from '@kiki/klient';

import { resolveKikiHome } from '#/kiki/home';
import { ensureServer } from '#/kiki/serve';
import { daemonRequest } from '#/kiki/seat';

interface Options {
  readonly url?: string;
  readonly client?: string;
  readonly home?: string;
  readonly credentialFile?: string;
  readonly args?: string;
  readonly argsFile?: string;
  readonly sessionRef?: string;
  readonly key?: string;
  readonly part?: string;
  readonly artifact?: string;
  readonly output?: string;
  readonly allowCommands?: boolean;
}

export function registerToolsCommand(program: Command): void {
  const tools = program
    .command('tools')
    .description('Call shared Kiki tools from scripts; all output is JSON.')
    .option('--url <url>', 'Kiki server URL; defaults to KIKI_SERVER_URL.')
    .option(
      '--client <id>',
      'Existing external-client connection; mint a short-lived credential through the local owner channel.',
    )
    .option('--home <dir>', 'Kiki home for local connection discovery.')
    .option(
      '--credential-file <path>',
      'Read the connection bearer credential from a file; otherwise use KIKI_EXTERNAL_CLIENT_TOKEN.',
    );
  tools
    .command('grant <names...>')
    .description('Add tool grants as the local owner; existing grants are retained.')
    .option('--allow-commands', 'Also allow local commands and unrestricted plugin access.')
    .action(async (names: string[], _options: unknown, command: Command) =>
      run(command, async (client, options) => {
        const api = client.rest!.externalClients;
        const current = await api.list();
        const saved = current.connections.find((connection) => connection.id === options.client);
        if (saved === undefined) throw new Error('External connection is unavailable.');
        const needsCommands = current.toolCatalog?.flatMap((group) => group.tools)
          .some((tool) => names.includes(tool.name) && tool.requiresCommands) === true;
        if (needsCommands && !saved.allowCommands && !options.allowCommands) {
          throw new Error('These tools require local-command access. Use --allow-commands only if you trust this client.');
        }
        return api.update(saved.id, {
          tools: [...new Set([...saved.tools, ...names])],
          allowCommands: options.allowCommands ? true : undefined,
        });
      }, true),
    );
  tools
    .command('credential')
    .description('Export a one-hour connection credential to a new private file as the local owner.')
    .requiredOption('--output <path>', 'New private output file; an existing file is never replaced.')
    .action(async (_options: unknown, command: Command) =>
      run(command, async (client, options) => {
        const output = resolve(options.output!);
        const file = await open(output, 'wx', 0o600);
        let complete = false;
        try {
          if (process.platform === 'win32') {
            await promisify(execFile)('icacls.exe', [output, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { windowsHide: true });
          } else {
            await file.chmod(0o600);
          }
          const credential = await client.rest!.externalClients.credential(options.client!);
          await file.writeFile(credential.token, 'utf8');
          await file.sync();
          complete = true;
          return { output, server_url: options.url, expires_at: credential.expiresAt };
        } finally {
          await file.close();
          if (!complete) await rm(output, { force: true });
        }
      }, true),
    );
  tools
    .command('list')
    .description('List the tools allowed by this connection.')
    .action(async (_options: unknown, command: Command) =>
      run(command, async (client) => client.rest!.externalClients.tools()),
    );
  tools
    .command('call <name>')
    .description('Submit once with a stable key; query the returned operation_id instead of resubmitting.')
    .option('--args <json>', 'Tool arguments as a JSON object.')
    .option('--args-file <path>', 'Read tool arguments from UTF-8 JSON; use - for stdin.')
    .option('--session-ref <ref>', 'Shared session reference from kiki_session list/new/resume.')
    .option('--key <key>', 'Stable idempotency key; required for side effects.')
    .action(async (name: string, _options: unknown, command: Command) =>
      run(command, async (client, options) => {
        if (options.args !== undefined && options.argsFile !== undefined) {
          throw new Error('Choose --args or --args-file.');
        }
        const text =
          options.args ??
          (options.argsFile === undefined
            ? '{}'
            : options.argsFile === '-'
              ? await stdin()
              : await readFile(options.argsFile, 'utf8'));
        const args: unknown = JSON.parse(text);
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          throw new Error('Tool arguments must be a JSON object.');
        }
        return client.rest!.externalClients.callTool(name, {
          arguments: args as Record<string, unknown>,
          session_ref: options.sessionRef,
          idempotency_key: options.key,
        });
      }),
    );
  const job = tools.command('job').description('Read an accepted operation or download its saved result.');
  job
    .command('get <id>')
    .action(async (id: string, _options: unknown, command: Command) =>
      run(command, async (client) => client.rest!.externalClients.job(id)),
    );
  job
    .command('download <id>')
    .requiredOption('--output <path>', 'New output file; an existing file is never replaced.')
    .option('--part <index>', 'Saved native output part index.')
    .option('--artifact <index>', 'Generated media artifact index from the saved media get result.')
    .action(async (id: string, _options: unknown, command: Command) =>
      run(command, async (client, options) => {
        if (options.part !== undefined && options.artifact !== undefined) {
          throw new Error('Choose --part or --artifact.');
        }
        const index = (value: string | undefined) => {
          if (value === undefined) {
            return undefined;
          }
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number < 0) {
            throw new Error('Index must be a nonnegative integer.');
          }
          return number;
        };
        const query: ExternalClientResultRange = {
          part: index(options.part),
          artifact: index(options.artifact),
          offset: 0,
          limit: 256_000,
        };
        const output = resolve(options.output!);
        const file = await open(output, 'wx');
        let bytes = 0;
        let complete = false;
        let pending = '';
        try {
          let offset = 0;
          while (true) {
            const page = await client.rest!.externalClients.result(id, { ...query, offset });
            const info = page.structuredContent;
            const range = info?.['range'] as
              | { start?: number; end?: number; total?: number; unit?: string }
              | undefined;
            if (
              range?.start !== offset ||
              typeof range.end !== 'number' ||
              typeof range.total !== 'number' ||
              range.end < offset ||
              range.end > range.total
            ) {
              throw new Error('Invalid result page range.');
            }
            const resource = page.content.find((part) => part.type === 'resource');
            let chunk: Buffer;
            if (resource?.type === 'resource' && resource.resource.blob !== undefined) {
              chunk = Buffer.from(resource.resource.blob, 'base64');
            } else {
              const part = page.content[1];
              if (part?.type !== 'text') {
                throw new Error('Result page has no downloadable content.');
              }
              let text = pending + part.text;
              pending = '';
              if (info?.['complete'] !== true && /[\uD800-\uDBFF]$/.test(text)) {
                pending = text.slice(-1);
                text = text.slice(0, -1);
              }
              chunk = Buffer.from(text, 'utf8');
            }
            await file.writeFile(chunk);
            bytes += chunk.byteLength;
            if (info?.['complete'] === true) {
              complete = true;
              break;
            }
            if (range.end === offset) {
              throw new Error('Result page made no progress.');
            }
            offset = range.end;
          }
        } finally {
          await file.close();
          if (!complete) {
            await rm(output, { force: true });
          }
        }
        return { operation_id: id, output, bytes };
      }),
    );
}

async function run(
  command: Command,
  work: (client: ReturnType<typeof createKlient>, options: Options) => Promise<unknown>,
  owner = false,
): Promise<void> {
  const options = command.optsWithGlobals<Options>();
  let token: string | undefined;
  let client: ReturnType<typeof createKlient> | undefined;
  try {
    token = owner ? undefined :
      options.credentialFile === undefined
        ? process.env['KIKI_EXTERNAL_CLIENT_TOKEN']
        : (await readFile(options.credentialFile, 'utf8')).trim();
    let endpoint = options.url ?? process.env['KIKI_SERVER_URL'];
    if (owner && options.client === undefined) throw new Error('This owner command requires --client ID.');
    if ((owner || token === undefined) && options.client !== undefined) {
      const connection = await ensureServer({ homeDir: resolveKikiHome(options.home) });
      token = owner ? connection.token : (await daemonRequest<{ token: string }>(
        connection, 'POST', `/api/external-clients/${encodeURIComponent(options.client)}/credential`, {},
      )).token;
      endpoint = connection.url;
    }
    if (!token || !endpoint) {
      throw new Error(
        'Supply --url and --credential-file (or KIKI_SERVER_URL and KIKI_EXTERNAL_CLIENT_TOKEN), or --client with an existing local connection.',
      );
    }
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error('Connection credentials require a loopback HTTP URL without embedded credentials.');
    }
    client = createKlient({ endpoint, token });
    const result = await work(client, { ...options, url: endpoint });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      typeof result === 'object' &&
      result !== null &&
      'isError' in result &&
      result.isError === true
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool request failed.';
    process.stdout.write(
      `${JSON.stringify({ error: token ? message.replaceAll(token, '[redacted]') : message })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
}

async function stdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}
