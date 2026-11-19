import { spawn } from 'node:child_process';
import { requestHookPermission } from '../agy-permission-hook.mjs';
import { terminate } from './catalog';
import { readNdjsonLines } from './ndjson';

interface JsonRpcRequest {
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: unknown };
  result?: { tools?: unknown };
}

interface SessionMcpLaunchSpec {
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export async function runSessionMcp(key: string): Promise<void> {
  if (!/^KIKI_AGY_MCP_[a-f0-9_]+_[0-9]+$/.test(key)) {
    throw new Error('Invalid session MCP environment key');
  }
  const rawServer = process.env[key];
  if (rawServer === undefined) {
    for await (const line of readNdjsonLines(process.stdin)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      if (!Object.hasOwn(request, 'id')) continue;
      let result: unknown;
      if (request.method === 'initialize') {
        result = {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'kiki-unbound-session', version: '1' },
        };
      } else if (request.method === 'tools/list') {
        result = { tools: [] };
      } else if (request.method === 'resources/list') {
        result = { resources: [] };
      } else if (request.method === 'resources/templates/list') {
        result = { resourceTemplates: [] };
      } else if (request.method === 'prompts/list') {
        result = { prompts: [] };
      } else if (request.method === 'ping') {
        result = {};
      }
      process.stdout.write(
        JSON.stringify(
          result === undefined
            ? {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32601, message: 'No Kiki session lease is bound to this process' },
              }
            : { jsonrpc: '2.0', id: request.id, result },
        ) + '\n',
      );
    }
    return;
  }

  const server = JSON.parse(rawServer) as Partial<SessionMcpLaunchSpec> | null;
  if (
    !server ||
    typeof server.command !== 'string' ||
    !Array.isArray(server.args) ||
    !Array.isArray(server.env)
  ) {
    throw new Error('Session MCP launch context is invalid');
  }
  const admission = await requestHookPermission({ type: 'mcp_bootstrap', key }, process.env, 10_000);
  if (admission.decision !== 'allow') {
    throw new Error('The session MCP bootstrap was not admitted by its owning adapter');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('KIKI_AGY_')) delete env[name];
  }
  const child = spawn(server.command, server.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = new Promise<number | null>((done) => child.once('close', done));
  const outputAbort = new AbortController();
  const inputAbort = new AbortController();
  let failure: unknown;
  const fail = (error: unknown): void => {
    failure ??= error;
    outputAbort.abort();
  };
  child.once('error', fail);
  child.stdin.on('error', fail);

  const lists = new Set<unknown>();
  const pumpInput = (async () => {
    try {
      for await (const line of readNdjsonLines(process.stdin, { signal: inputAbort.signal })) {
        try {
          const frame = JSON.parse(line) as JsonRpcRequest;
          if (frame.method === 'tools/list' && frame.id !== undefined) {
            lists.add(frame.id);
          }
        } catch {}
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.write(line + '\n');
        }
      }
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    } catch {}
  })();

  child.stderr.pipe(process.stderr);
  const stop = (): void => {
    void terminate(child).catch(fail);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    let ready = false;
    for await (const line of readNdjsonLines(child.stdout, { signal: outputAbort.signal })) {
      let frame: JsonRpcRequest | undefined;
      try {
        frame = JSON.parse(line) as JsonRpcRequest;
      } catch {}
      if (!ready && lists.has(frame?.id) && Array.isArray(frame?.result?.tools)) {
        const acknowledged = await requestHookPermission(
          { type: 'mcp_ready', key },
          process.env,
          10_000,
        );
        if (acknowledged.decision !== 'allow') {
          throw new Error('The session MCP readiness was not admitted by its owning adapter');
        }
        ready = true;
      }
      process.stdout.write(line + '\n');
    }
    if (failure instanceof Error) throw new Error(failure.message, { cause: failure });
    if (failure) throw new Error('AGY session MCP child failed', { cause: failure });
    process.exitCode = (await closed) ?? 1;
  } finally {
    inputAbort.abort();
    process.stdin.pause();
    outputAbort.abort();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child.pid !== undefined) await terminate(child);
    await closed;
    await pumpInput;
  }
}
