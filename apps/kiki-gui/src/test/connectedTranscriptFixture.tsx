import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { act, useLayoutEffect, type ReactElement, type ReactNode } from 'react';
import { expect } from 'vitest';
import { browserHost, HostProvider } from '../host';
import { ConnectionProvider } from '../state/connection';
import { writeStoredConfig } from '../state/connectionConfig';

export function createConnectedTranscriptFixture() {
  let processHandle: ChildProcess | undefined;
  let startup: Promise<string> | undefined;

  function start(): Promise<string> {
    startup ??= new Promise((ready, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', "import { startFixtureServer } from './scripts/fixture-server.mjs'; const server = await startFixtureServer({port: 0, scenario: 'queue'}); console.log('TEST_FIXTURE_PORT:' + server.http.address().port);"], { cwd: resolve(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] });
      processHandle = child;
      let output = '';
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const port = /TEST_FIXTURE_PORT:(\d+)/.exec(output)?.[1];
        if (port !== undefined) ready(`http://127.0.0.1:${port}`);
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Transcript fixture exited: ${code}\n${stderr}`)));
    });
    return startup;
  }

  return {
    start,
    async render(node: ReactNode, paint: (node: ReactElement) => Promise<void>): Promise<void> {
      writeStoredConfig({ url: await start(), token: 'kiki-fixture-token' });
      let mounted = false;
      function ConnectedSurface() {
        useLayoutEffect(() => { mounted = true; }, []);
        return node;
      }
      await paint(<HostProvider host={browserHost}><ConnectionProvider><ConnectedSurface /></ConnectionProvider></HostProvider>);
      for (let attempt = 0; !mounted && attempt < 100; attempt += 1) {
        await act(async () => { await new Promise((ready) => setTimeout(ready, 10)); });
      }
      expect(mounted).toBe(true);
    },
    async close(): Promise<void> {
      const child = processHandle;
      if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => { child.once('exit', () => done()); });
      child.kill();
      await exited;
    },
  };
}
