import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { HARNESS_HOOK_SCRIPT, createHarnessHooks, codexHookConfig } from '../src/mcp/harnessHooks';

function runScript(script: string, harness: string, event: string, endpoint: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, harness, event], { env: { ...process.env, KIKI_KAP_ENDPOINT: endpoint, KIKI_DELEGATION_TOKEN: 'fixture-token' } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`hook exited ${code}`)));
    child.stdin.end('{}');
  });
}

describe('process-local harness hooks', () => {
  it('uses the native command-hook wire for Claude, Codex, and Antigravity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-hook-wire-'));
    const script = join(directory, 'hook.mjs');
    await writeFile(script, HARNESS_HOOK_SCRIPT);
    const calls: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push(JSON.parse(body));
      expect(request.url).toBe('/api/klient/delegation/context/hook');
      expect(request.headers.authorization).toBe('Bearer fixture-token');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { content: 'Keep the working notes.' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No listener');
      const endpoint = `http://127.0.0.1:${address.port}`;
      expect(await runScript(script, 'claude', 'SessionStart', endpoint)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Keep the working notes.' } });
      expect(await runScript(script, 'codex', 'UserPromptSubmit', endpoint)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Keep the working notes.' } });
      expect(await runScript(script, 'antigravity', 'PreInvocation', endpoint)).toEqual({ injectSteps: [{ userMessage: 'Keep the working notes.' }] });
      expect(calls).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('pins trust only to Kiki command identities, matching the donor fingerprint', () => {
    const config = codexHookConfig({ PreToolUse: [{ hooks: [{ type: 'command', command: 'kiki-context-hook pre-tool-use', timeout: 600 }] }] });
    expect(Object.values(config.state)).toEqual([{ trusted_hash: 'sha256:70e6c516cee241b305732f60928db56716d3ec5cc49a41a74d453e2477bacd4a' }]);
    expect(config).not.toHaveProperty('bypass_hook_trust');
  });

  it('creates isolated settings or native callback metadata and removes its own artifacts', async () => {
    for (const id of ['claude-acp', 'grok-acp', 'codex-app-server', 'codex-acp']) {
      const lease = await createHarnessHooks(id);
      let path: string;
      try {
        if (id === 'claude-acp') {
          path = (lease.sessionMeta as { claudeCode: { options: { settings: string } } }).claudeCode.options.settings;
          expect(JSON.parse(await readFile(path, 'utf8')).hooks).toHaveProperty('SessionStart');
        } else if (id === 'grok-acp') {
          expect(lease.sessionMeta).toEqual({ 'x.ai/hooks': { Stop: [{ hookCallbackIds: ['kiki-context'], timeout: 15 }] } });
          expect(lease.processArgs).toBeUndefined();
          expect(lease.processEnv).toBeUndefined();
          continue;
        } else if (id === 'codex-acp') {
          expect(JSON.parse(lease.processEnv!['CODEX_CONFIG']!).hooks.state).toBeDefined();
          path = JSON.parse(lease.processEnv!['CODEX_CONFIG']!).hooks.SessionStart[0].hooks[0].command.match(/"([^"]+)"/)[1];
        } else {
          expect(lease.processArgs?.[0]).toBe('-c');
          expect(lease.processArgs?.[1]).toContain('trusted_hash');
          continue;
        }
        expect(path).toContain('kiki-context-hooks-');
        expect(dirname(path)).not.toBe(process.cwd());
      } finally {
        await lease.dispose();
      }
      await expect(access(path!)).rejects.toThrow();
    }
  });

  it('isolates Antigravity hook settings without changing original settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemini-fixture-'));
    const config = join(directory, 'config');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(config);
    const original = JSON.stringify({ 'existing-hook': { enabled: false } });
    await writeFile(join(config, 'hooks.json'), original);
    vi.stubEnv('GEMINI_HOME', directory);
    const lease = await createHarnessHooks('antigravity-acp');
    try {
      expect(lease.processEnv!['GEMINI_HOME']).not.toBe(directory);
      const hooks = JSON.parse(await readFile(join(lease.processEnv!['GEMINI_HOME']!, 'config', 'hooks.json'), 'utf8'));
      expect(hooks).toMatchObject({ 'existing-hook': { enabled: false }, 'kiki-context': { enabled: true } });
      expect(await readFile(join(config, 'hooks.json'), 'utf8')).toBe(original);
    } finally {
      await lease.dispose();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
