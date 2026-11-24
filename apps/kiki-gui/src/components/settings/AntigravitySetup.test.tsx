// @vitest-environment jsdom
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserHost, HostProvider } from '../../host';
import { I18nProvider } from '../../i18n';
import { ConnectionProvider } from '../../state/connection';
import { writeStoredConfig } from '../../state/connectionConfig';
import { AntigravitySetup } from './AntigravitySetup';

let serverProcess: ChildProcess | undefined;
let serverUrl = '';
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const openedUrls: string[] = [];

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
    });
  }
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>)['__KIKI_PROXY_TARGET__'] ??= 'http://127.0.0.1:5494';
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  serverUrl = await new Promise<string>((ready, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { startFixtureServer } from './scripts/fixture-server.mjs'; const server = await startFixtureServer({port: 0, scenario: 'antigravity-bridge'}); console.log('TEST_FIXTURE_PORT:' + server.http.address().port);",
      ],
      { cwd: resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    serverProcess = child;
    let output = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const port = /TEST_FIXTURE_PORT:(\d+)/.exec(output)?.[1];
      if (port !== undefined) ready(`http://127.0.0.1:${port}`);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Antigravity fixture server exited: ${code}\n${stderr}`)));
  });
}, 60_000);

afterAll(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const child = serverProcess;
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => {
      child.once('exit', () => done());
    });
    child.kill();
    await exited;
  }
});

beforeEach(async () => {
  openedUrls.length = 0;
  localStorage.setItem('kiki.locale', 'en');
  await fetch(`${serverUrl}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer kiki-fixture-token' },
    body: JSON.stringify({ action: 'scenario', name: 'antigravity-bridge' }),
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function renderSetup(
  props: { instanceId?: string; ready?: boolean; ideDetected?: boolean; onChanged?: () => void } = {},
): Promise<HTMLDivElement> {
  writeStoredConfig({ url: serverUrl, token: 'kiki-fixture-token' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  let mounted = false;
  function ConnectedSetup() {
    useLayoutEffect(() => {
      mounted = true;
    }, []);
    return (
      <AntigravitySetup
        login="logged_out"
        ready={props.ready ?? true}
        ideDetected={props.ideDetected ?? false}
        instanceId={props.instanceId}
        onChanged={props.onChanged ?? vi.fn()}
      />
    );
  }
  const host = {
    ...browserHost,
    openUrl: async (url: string) => {
      openedUrls.push(url);
    },
  };
  await act(async () => {
    root!.render(
      <I18nProvider>
        <HostProvider host={host}>
          <ConnectionProvider>
            <ConnectedSetup />
          </ConnectionProvider>
        </HostProvider>
      </I18nProvider>,
    );
  });
  for (let attempt = 0; !mounted && attempt < 80; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
    });
  }
  expect(mounted).toBe(true);
  await settle();
  return container;
}

describe('AntigravitySetup (1.5+ flagship real-wire flow)', () => {
  it('renders CLI runtime bar with update badge, completes code_paste login, and displays signed-in profile + entitled models', async () => {
    const onChanged = vi.fn();
    const el = await renderSetup({ onChanged });

    expect(el.querySelector('[data-antigravity-update]')?.textContent).toContain('1.5.12');
    expect(el.textContent).toContain('Official CLI');

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-antigravity-signin]')!.click();
    });
    await settle();
    expect(openedUrls[0]).toContain('accounts.google.com');
    expect(el.querySelector('[data-antigravity-login="pending"]')?.getAttribute('data-antigravity-flow')).toBe('code_paste');

    const input = el.querySelector<HTMLInputElement>('[data-antigravity-redirect]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '4/0A-raw-auth-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = el.querySelector<HTMLButtonElement>('[data-antigravity-complete]')!;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => {
      submitBtn.click();
    });
    await settle();

    expect(onChanged).toHaveBeenCalled();
    expect(el.querySelector('[data-antigravity-signed-in]')?.textContent).toContain('alex@example.com');
    expect(el.querySelector('[data-antigravity-auto-mode]')).not.toBeNull();
    expect(el.querySelector('[data-antigravity-models]')?.textContent).toContain('Gemini 3.1 Pro');
    expect(el.querySelector('[data-antigravity-models]')?.textContent).toContain('Claude Sonnet 4.6');
  });

  it('scopes profile state and model refresh to an isolated multi-account instanceId', async () => {
    const el = await renderSetup({ instanceId: 'instance-agy-work' });
    expect(el.querySelector('[data-antigravity-instance="instance-agy-work"]')).not.toBeNull();
    expect(el.querySelector('[data-antigravity-signed-in]')?.textContent).toContain('work@example.com');

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-antigravity-refresh-models]')!.click();
    });
    await settle();
    expect(el.querySelector('[data-antigravity-models]')?.textContent).toContain('Claude Opus 4.6');
  });

  it('exposes Account & access sign-in controls for PATH/custom-path agy installs without a managed active_version', async () => {
    await fetch(`${serverUrl}/__control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer kiki-fixture-token' },
      body: JSON.stringify({ action: 'scenario', name: 'external-main' }),
    });
    const el = await renderSetup({ ready: true, ideDetected: false });
    expect(el.querySelector('[data-antigravity-version="external"]')).not.toBeNull();
    expect(el.querySelector('[data-antigravity-signin]')).not.toBeNull();
    expect(el.querySelector('[data-antigravity-install]')).not.toBeNull();
  });
});
