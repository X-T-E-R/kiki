import type { Command } from 'commander';
import { ensureServer, parseDuration, type ServerConnection } from './serve';
import { resolveKikiHome } from './home';

const SESSION_ACCESS_SCOPES = ['read', 'prompt', 'abort'] as const;
type SessionAccessScope = typeof SESSION_ACCESS_SCOPES[number];

interface SessionAccessEnvelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

async function sessionAccessRequest<T>(
  connection: ServerConnection,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set('content-type', 'application/json');
  const request: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const response = await fetch(`${connection.url}${path}`, request);
  const envelope = await response.json() as SessionAccessEnvelope<T>;
  if (!response.ok || envelope.code !== 0) {
    throw new Error(envelope.msg || `Session access request failed (HTTP ${response.status}).`);
  }
  return envelope.data;
}

function parseScopes(value: string): SessionAccessScope[] {
  const scopes = value.split(',').map((scope) => scope.trim());
  if (scopes.length === 0 || scopes.some((scope) => !SESSION_ACCESS_SCOPES.includes(scope as SessionAccessScope))) {
    throw new Error('Invalid --scope. Choose one or more of: read, prompt, abort.');
  }
  if (new Set(scopes).size !== scopes.length) throw new Error('--scope must not repeat a scope.');
  return scopes as SessionAccessScope[];
}

function parseTtlSeconds(value: string | undefined): number {
  if (value === undefined) return 3600;
  let ttlMs: number;
  try {
    ttlMs = parseDuration(value);
  } catch {
    throw new Error('--ttl must be a duration such as 1h, from 60s through 24h.');
  }
  if (ttlMs < 60_000 || ttlMs > 86_400_000 || ttlMs % 1_000 !== 0) {
    throw new Error('--ttl must be a whole number of seconds from 60s through 24h.');
  }
  return ttlMs / 1_000;
}

export function registerSessionAccessCommand(program: Command): void {
  const group = program.command('session-access').description('Manage local session-access tokens.').option('--home <dir>', 'Local Kiki home.');
  const connect = async (command: Command) => ensureServer({
    homeDir: resolveKikiHome(command.optsWithGlobals()['home'] as string | undefined),
  });

  group.command('list')
    .description('List session-access token metadata without revealing token secrets.')
    .action(async (_options, command: Command) => {
      const connection = await connect(command);
      const tokens = await sessionAccessRequest(connection, 'GET', '/api/session-access');
      process.stdout.write(`${JSON.stringify(tokens, null, 2)}\n`);
    });

  group.command('issue')
    .requiredOption('--session <id>', 'Session to grant access to.')
    .requiredOption('--scope <scopes>', 'Comma-separated scopes: read,prompt,abort.', parseScopes)
    .requiredOption('--name <client>', 'Name for the client receiving the token.')
    .option('--ttl <dur>', 'Token lifetime in whole seconds, from 60s through 24h (default 1h).')
    .description('Issue a session-scoped access token; its secret is printed once.')
    .action(async (options: { session: string; scope: SessionAccessScope[]; name: string; ttl?: string }, command: Command) => {
      if (options.session.trim().length === 0) throw new Error('--session must not be empty.');
      if (options.name.trim().length === 0) throw new Error('--name must not be empty.');
      const ttlSeconds = parseTtlSeconds(options.ttl);
      const connection = await connect(command);
      const issued = await sessionAccessRequest(connection, 'POST', '/api/session-access/tokens', {
        session_id: options.session,
        scopes: options.scope,
        client: { name: options.name },
        ttl_seconds: ttlSeconds,
      });
      process.stdout.write(`${JSON.stringify(issued, null, 2)}\n`);
    });

  group.command('revoke [token_id]')
    .option('--all', 'Revoke every session-access token.')
    .description('Revoke one session-access token by id, or all tokens with --all.')
    .action(async (tokenId: string | undefined, options: { all?: boolean }, command: Command) => {
      let path: string;
      if (options.all === true) {
        if (tokenId !== undefined) throw new Error('Use either a token_id or --all, not both.');
        path = '/api/session-access/tokens';
      } else {
        if (tokenId === undefined) throw new Error('Provide a token_id or use --all.');
        path = `/api/session-access/tokens/${encodeURIComponent(tokenId)}`;
      }
      const connection = await connect(command);
      const result = await sessionAccessRequest(connection, 'DELETE', path);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
}
