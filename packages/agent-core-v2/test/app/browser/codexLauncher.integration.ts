import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it } from 'vitest';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { openCodexBrowser, type BrowserRequestContext } from '#/app/browser/codexBrowser';

const runtimeRoot = process.env['KIKI_CODEX_BROWSER_TEST_RUNTIME'];

describe.skipIf(runtimeRoot === undefined)('installed official cua-repl launcher, no browser access', () => {
  it('initializes, discovers the official js schema and executes harmless JS with Kiki caller metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-codex-launcher-'));
    const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: 'official-launcher' },
      { capabilities: ['process', 'fs'], pathClass: process.platform === 'win32' ? 'win32' : 'posix',
        environment: { osKind: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux' } }),
      { fs: new HostFileSystem(), process: new HostProcessService() });
    const context: BrowserRequestContext = { caller: { sessionId: 'fixture-official-launcher', agentId: 'main' }, turnId: 1,
      toolCallId: 'fixture-js', elicit: async () => ({ action: 'cancel' }) };
    let backend: Awaited<ReturnType<typeof openCodexBrowser>> | undefined;
    try {
      backend = await openCodexBrowser({ runtimeRoot: runtimeRoot!, browserId: 'unused-no-browser-access', cwd: root, runtime,
        resolver: { _serviceBrand: undefined, inspect: () => runtime, acquire: () => ({ runtime, track: (resource) => resource, dispose: () => undefined }) } });
      const tools = await backend.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['codex_browser_js', 'codex_browser_js_reset']);
      expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: { code: expect.any(Object) } });
      const result = await backend.official!.invoke('codex_browser_js', { code: 'nodeRepl.write("KIKI_OFFICIAL_LAUNCHER_JS:" + String(2 + 3));' }, undefined, context);
      expect(result.isError).toBe(false);
      expect(result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')).toContain('KIKI_OFFICIAL_LAUNCHER_JS:5');
      const reset = await backend.official!.invoke('codex_browser_js_reset', {}, undefined, context);
      expect(reset.isError).toBe(false);
      await backend.official!.endTurn(context.caller, context.turnId);
      await backend.official!.endTurn(context.caller, context.turnId);
      console.log(JSON.stringify({ scope: 'official launcher, reset and turn cleanup only; no browser inventory or actions', version: backend.version, tools, result, reset }));
    } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
  }, 70_000);
});
