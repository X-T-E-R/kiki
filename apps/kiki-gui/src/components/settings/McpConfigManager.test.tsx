// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpManagedServer } from '@kiki/session-core/transport';
import { I18nProvider } from '../../i18n';
import { McpConfigManager } from './McpConfigManager';
import { pickOption } from './testControls';

const mcp = vi.hoisted(() => ({
  add: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn(),
  resetAuth: vi.fn(), listStoredOAuthCredentials: vi.fn(), revealStoredOAuthCredential: vi.fn(), revokeStoredOAuthCredential: vi.fn(),
}));
const revealSecret = vi.hoisted(() => vi.fn());
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ klient: { global: { mcp } }, client: { revealSecret }, scopeId: 'fixture-server' }),
}));
const STORED_HEADERS: Readonly<Record<string, string>> = { Authorization: 'Bearer fixture=old', 'X-Team': 'alpha' };

const remote: McpManagedServer = {
  name: 'remote',
  config: {
    transport: 'http', url: 'https://old.example.test/mcp',
    headerKeys: ['Authorization', 'X-Team'],
  },
  source: 'global', origin: '/tmp/fixture-mcp.json', mutable: true,
};
const envRemote: McpManagedServer = {
  ...remote,
  config: {
    transport: 'http', url: 'https://old.example.test/mcp',
    headerKeys: ['Authorization', 'X-Team'],
    bearerTokenEnvVar: 'MCP_TOKEN', auth: 'oauth',
  },
};
const readOnly: McpManagedServer = {
  name: 'plugin-remote',
  config: { transport: 'sse', url: 'https://plugin.example.test/mcp', headerKeys: ['Authorization'] },
  source: 'plugin', origin: 'fixture-plugin', mutable: false,
};

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mcp.add.mockReset();
  mcp.update.mockReset();
  mcp.remove.mockReset();
  mcp.test.mockReset();
  mcp.resetAuth.mockReset();
  mcp.listStoredOAuthCredentials.mockReset();
  mcp.revealStoredOAuthCredential.mockReset();
  mcp.revokeStoredOAuthCredential.mockReset();
  mcp.update.mockResolvedValue([remote, readOnly]);
  revealSecret.mockReset();
  revealSecret.mockImplementation(async (ref: { kind: string; key?: string }) => (
    ref.kind === 'mcp_bearer_env' ? { source: 'environment', env_name: 'MCP_TOKEN', value: 'env-fixture-token' }
      : { source: 'kiki', value: STORED_HEADERS[ref.key ?? ''] }));
  mcp.test.mockResolvedValue({ success: true, output: '' });
  mcp.resetAuth.mockResolvedValue(undefined);
  mcp.listStoredOAuthCredentials.mockResolvedValue([]);
  mcp.revealStoredOAuthCredential.mockResolvedValue({ canonicalUrl: 'https://orphan.example.test/mcp' });
  mcp.revokeStoredOAuthCredential.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(entries: readonly McpManagedServer[] = [remote, readOnly], loading = false): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><MemoryRouter><McpConfigManager cwd="/tmp/fixture" entries={entries} loading={loading} error={null} onEcho={vi.fn()} /></MemoryRouter></I18nProvider>
      </QueryClientProvider>,
    );
  });
  // Editors open in a portaled side panel, so the whole document is the surface.
  return document.body as HTMLDivElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const valueInputs = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>('[data-secret-field] input')];
const keyInputs = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>('[data-mcp-secret-row] > label input')];
async function editValue(root: ParentNode, index: number, value: string): Promise<void> {
  const row = root.querySelectorAll('[data-mcp-secret-row]')[index]!;
  const edit = row.querySelector<HTMLButtonElement>('[data-secret-edit]');
  if (edit !== null) await click(edit);
  await act(async () => { await Promise.resolve(); });
  await change(row.querySelector<HTMLInputElement>('[data-secret-field] input')!, value);
}

async function openRemote(container: HTMLDivElement): Promise<HTMLFieldSetElement> {
  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!);
  return container.querySelector('fieldset')!;
}

describe('MCP managed header editor', () => {
  it('shows loading and empty states without revealing any values', async () => {
    const loading = await render([], true);
    expect(loading.textContent).toContain('Loading configured entries');
    expect(loading.textContent).not.toContain('No MCP entries configured');
    const empty = await render([]);
    expect(empty.textContent).toContain('No MCP entries configured');
    expect(empty.querySelector('input[type="password"]')).toBeNull();
  });

  it('lists header keys masked, reveals a value only on request, and sends the edited draft to test and save', async () => {
    const container = await render();
    const fieldset = await openRemote(container);
    expect(keyInputs(fieldset).map((input) => input.value)).toEqual(['Authorization', 'X-Team']);
    expect(valueInputs(fieldset).every((input) => !input.value.includes('fixture'))).toBe(true);
    expect(revealSecret).not.toHaveBeenCalled();
    await click(fieldset.querySelector('[data-mcp-secret-row="0"] [data-secret-reveal]')!);
    await act(async () => { await Promise.resolve(); });
    expect(revealSecret).toHaveBeenCalledWith({ kind: 'mcp_header', server: 'remote', key: 'Authorization', cwd: '/tmp/fixture' });
    expect(valueInputs(fieldset)[0]!.value).toBe('Bearer fixture=old');
    await editValue(fieldset, 0, 'Bearer fixture=new=part');
    await click(fieldset.querySelector('[aria-label="Remove header 2"]')!);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test).toHaveBeenCalledWith({
      server: expect.objectContaining({ name: 'remote', transport: 'http', headers: { Authorization: 'Bearer fixture=new=part' } }),
      cwd: '/tmp/fixture',
    });
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.update).toHaveBeenCalledWith({
      server: expect.objectContaining({ name: 'remote', transport: 'http', headers: { Authorization: 'Bearer fixture=new=part' } }),
      cwd: '/tmp/fixture',
    });
  });

  it('renames by adding the new name before removing the old one', async () => {
    mcp.add.mockResolvedValue([remote, readOnly]);
    mcp.remove.mockResolvedValue([readOnly]);
    const container = await render();
    const fieldset = await openRemote(container);
    await change(fieldset.querySelector<HTMLInputElement>('input')!, 'renamed');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.add).toHaveBeenCalledWith({ server: expect.objectContaining({ name: 'renamed' }), cwd: '/tmp/fixture' });
    expect(mcp.remove).toHaveBeenCalledWith({ name: 'remote', cwd: '/tmp/fixture' });
    expect(mcp.add.mock.invocationCallOrder[0]).toBeLessThan(mcp.remove.mock.invocationCallOrder[0]!);
    expect(mcp.update).not.toHaveBeenCalled();
  });

  it('shows the effective env source, disables overridden Authorization, and replaces the reference', async () => {
    const container = await render([envRemote]);
    const fieldset = await openRemote(container);
    const bearer = fieldset.querySelector<HTMLInputElement>('[data-mcp-bearer-env]')!;
    const authorization = valueInputs(fieldset.querySelector('[data-mcp-secret-rows="headers"]')!)[0]!;
    expect(bearer.value).toBe('MCP_TOKEN');
    expect(authorization.disabled).toBe(true);
    // The env-sourced token is still viewable, read-only.
    const bearerValue = fieldset.querySelector('[data-mcp-bearer-value]')!;
    expect(bearerValue.textContent).toContain('From environment variable MCP_TOKEN');
    expect(bearerValue.querySelector('[data-secret-edit]')).toBeNull();
    await click(bearerValue.querySelector('[data-secret-reveal]')!);
    await act(async () => { await Promise.resolve(); });
    expect(revealSecret).toHaveBeenCalledWith({ kind: 'mcp_bearer_env', server: 'remote', cwd: '/tmp/fixture' });
    expect(bearerValue.querySelector('input')!.value).toBe('env-fixture-token');
    expect(fieldset.querySelector<HTMLButtonElement>('[aria-label="Remove header 1"]')!.disabled).toBe(true);
    expect(fieldset.textContent).toContain('Authorization: server environment');
    expect(fieldset.textContent).toContain('prevents OAuth from attaching');
    await change(bearer, 'NEW_TOKEN');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test.mock.calls[0]![0].server).toMatchObject({ bearerTokenEnvVar: 'NEW_TOKEN', auth: 'oauth' });
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.update.mock.calls[0]![0].server).toMatchObject({ bearerTokenEnvVar: 'NEW_TOKEN', auth: 'oauth' });
  });

  it('clears the env reference before editing or removing effective Authorization, retaining OAuth', async () => {
    const container = await render([envRemote]);
    const fieldset = await openRemote(container);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Clear env reference')!);
    const authorization = valueInputs(fieldset)[0]!;
    expect(authorization.disabled).toBe(false);
    expect(fieldset.querySelector<HTMLButtonElement>('[aria-label="Remove header 1"]')!.disabled).toBe(false);
    expect(fieldset.textContent).toContain('Authorization: this header');
    expect(fieldset.querySelector('[data-mcp-bearer-value]')).toBeNull();
    await editValue(fieldset, 0, 'Bearer fixture=new');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test.mock.calls[0]![0].server).toMatchObject({
      bearerTokenEnvVar: undefined, auth: 'oauth',
      headers: { Authorization: 'Bearer fixture=new', 'X-Team': 'alpha' },
    });
    await click(fieldset.querySelector('[aria-label="Remove header 1"]')!);
    expect(fieldset.textContent).toContain('Authorization: saved OAuth token');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.update.mock.calls[0]![0].server).toMatchObject({
      bearerTokenEnvVar: undefined, auth: 'oauth', headers: { 'X-Team': 'alpha' },
    });
  });

  it('clears all headers and permits locally adding or deleting rows', async () => {
    const container = await render();
    const fieldset = await openRemote(container);
    await click(fieldset.querySelector('[aria-label="Remove header 2"]')!);
    await click(fieldset.querySelector('[aria-label="Remove header 1"]')!);
    expect(valueInputs(fieldset)).toHaveLength(0);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Add header')!);
    expect(valueInputs(fieldset)).toHaveLength(1);
    expect(valueInputs(fieldset)[0]!.type).toBe('password');
    await click(fieldset.querySelector('[aria-label="Remove header 1"]')!);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.update.mock.calls[0]![0].server.headers).toBeUndefined();
  });

  it('adds a header row and saves its key and complete value', async () => {
    const container = await render();
    const fieldset = await openRemote(container);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Add header')!);
    await change(keyInputs(fieldset)[2]!, 'X-Fixture');
    await change(valueInputs(fieldset)[2]!, 'part=one=two');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    // Untouched saved rows are read back through the reveal route at save time.
    await act(async () => { await Promise.resolve(); });
    expect(revealSecret).toHaveBeenCalledTimes(2);
    expect(mcp.update.mock.calls[0]![0].server.headers).toEqual({
      Authorization: 'Bearer fixture=old', 'X-Team': 'alpha', 'X-Fixture': 'part=one=two',
    });
  });

  it('drops headers, env reference, and OAuth on URL or transport change, even after switching back', async () => {
    const container = await render([envRemote]);
    const fieldset = await openRemote(container);
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://new.example.test/mcp');
    expect(fieldset.querySelector('input[type="password"]')).toBeNull();
    expect(fieldset.querySelector<HTMLInputElement>('[data-mcp-bearer-env]')!.value).toBe('');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test.mock.calls[0]![0].server).toMatchObject({ url: 'https://new.example.test/mcp', headers: undefined, bearerTokenEnvVar: undefined, auth: undefined });
    const transport = fieldset.querySelector('[data-mcp-transport]')!;
    await pickOption(transport, 'sse');
    await pickOption(transport, 'http');
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://old.example.test/mcp');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(mcp.update.mock.calls[0]![0].server).toMatchObject({ headers: undefined, bearerTokenEnvVar: undefined, auth: undefined });
  });

  it('rejects duplicate header names differing only in case before testing or saving', async () => {
    const container = await render();
    const fieldset = await openRemote(container);
    await change(keyInputs(fieldset)[1]!, 'authorization');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Header names must be unique');
    expect(mcp.update).not.toHaveBeenCalled();
  });

  it('does not show A test success after switching the draft to B', async () => {
    let resolveOld!: (result: { success: boolean; output: string }) => void;
    mcp.test.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const other: McpManagedServer = {
      name: 'other', config: { transport: 'sse', url: 'https://other.example.test/mcp' },
      source: 'global', origin: '/tmp/fixture-mcp.json', mutable: true,
    };
    const container = await render([remote, other]);
    const edits = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Edit');
    await click(edits[0]!);
    await click([...container.querySelectorAll('fieldset button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test).toHaveBeenCalledTimes(1);
    await click(edits[1]!);
    expect(container.querySelector('fieldset')!.textContent).toContain('Authorization: saved OAuth token');
    await act(async () => { resolveOld({ success: true, output: 'A result' }); await Promise.resolve(); });
    expect(container.textContent).not.toContain('A result');
    await click([...container.querySelectorAll('fieldset button')].find((button) => button.textContent === 'Test connection')!);
    expect(mcp.test.mock.calls[1]![0].server.name).toBe('other');
  });

  it('does not let an old test error overwrite a changed URL and a successful save', async () => {
    let rejectOld!: (error: Error) => void;
    mcp.test.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    const container = await render([remote]);
    const fieldset = await openRemote(container);
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Test connection')!);
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://new.example.test/mcp');
    await click([...fieldset.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
    await act(async () => { rejectOld(new Error('Old probe failed')); await Promise.resolve(); });
    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
    expect(container.textContent).not.toContain('Old probe failed');
  });

  it('never offers read-only plugin secrets for editing or reveal', async () => {
    const container = await render([readOnly]);
    expect(container.textContent).toContain('Read-only');
    expect(container.textContent).not.toContain('Authorization');
    expect(container.querySelector('fieldset')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Edit')).toBe(false);
  });
});

describe('MCP OAuth credential reset', () => {
  const action = 'Clear saved OAuth credentials';
  const buttons = (container: HTMLDivElement) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === action);

  it('offers a separate reset even when a bearer reference or static Authorization hides latent OAuth tokens', async () => {
    const other: McpManagedServer = { ...remote, name: 'other-remote' };
    const container = await render([envRemote, other]);
    expect(buttons(container)).toHaveLength(2);
    const fieldset = await openRemote(container);
    await change(fieldset.querySelector<HTMLInputElement>('[data-mcp-bearer-env]')!, 'OTHER_TOKEN');
    expect(mcp.resetAuth).not.toHaveBeenCalled();
    await click(buttons(container)[0]!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('If saved OAuth credentials exist');
    expect(dialog.textContent).toContain('https://old.example.test/…');
    expect(dialog.textContent).not.toContain('/mcp');
    expect(mcp.resetAuth).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!);
    expect(mcp.resetAuth).not.toHaveBeenCalled();
    await click(buttons(container)[0]!);
    await click([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === 'Clear OAuth credentials')!);
    expect(mcp.resetAuth).toHaveBeenCalledExactlyOnceWith({
      locator: { source: 'global', name: 'remote' }, cwd: '/tmp/fixture',
      expectedCanonicalUrl: 'https://old.example.test/mcp',
    });
    expect(mcp.update).not.toHaveBeenCalled();
    expect(mcp.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain('cleared, if any existed');
  });

  it('does not offer reset for read-only, stdio or ambiguous same-name entries', async () => {
    const stdio: McpManagedServer = {
      name: 'local', config: { transport: 'stdio', command: 'fixture' },
      source: 'global', origin: '/tmp/fixture-mcp.json', mutable: true,
    };
    const unique = await render([remote, readOnly, stdio]);
    expect(buttons(unique)).toHaveLength(1);
    // One mount at a time: the query surface is the whole document.
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
    const ambiguous = await render([remote, { ...readOnly, name: 'remote' }, stdio]);
    expect(buttons(ambiguous)).toHaveLength(0);
  });

  it('does not claim success on a failed reset and permits an explicit retry', async () => {
    mcp.resetAuth.mockRejectedValueOnce(new Error('fixture failure'));
    const container = await render([remote]);
    await click(buttons(container)[0]!);
    await click(document.querySelector('[role="alertdialog"] button:last-child')!);
    expect(container.textContent).toContain('Could not clear saved OAuth credentials');
    expect(container.textContent).not.toContain('cleared, if any existed');
    await click(buttons(container)[0]!);
    await click(document.querySelector('[role="alertdialog"] button:last-child')!);
    expect(mcp.resetAuth).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('cleared, if any existed');
  });

  it('blocks duplicate reset and cancellation while its request is pending', async () => {
    let resolve!: () => void;
    mcp.resetAuth.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const container = await render([remote]);
    await click(buttons(container)[0]!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await click(dialog.querySelector('button:last-child')!);
    expect(mcp.resetAuth).toHaveBeenCalledTimes(1);
    expect((dialog.querySelector('button:last-child') as HTMLButtonElement).disabled).toBe(true);
    await click(dialog);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('masks URL secrets until Reveal, keeps readonly configs immutable and revokes only the selected opaque id', async () => {
    const secretUrl = 'https://user:fixture-secret@a.example.test/mcp?api_key=fixture-secret';
    const saved = [
      { credentialId: 'a'.repeat(64), serverName: 'former', displayUrl: 'https://a.example.test/…', origin: 'unknown' },
      { credentialId: 'b'.repeat(64), serverName: 'former', displayUrl: 'https://b.example.test/…', origin: 'unknown' },
    ];
    mcp.listStoredOAuthCredentials.mockResolvedValueOnce(saved).mockResolvedValue(saved.slice(1));
    mcp.revealStoredOAuthCredential.mockResolvedValue({ canonicalUrl: secretUrl });
    const container = await render([readOnly]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('Saved connection');
    expect(container.textContent).toContain('https://a.example.test/…');
    expect(container.textContent).toContain('https://b.example.test/…');
    expect(container.outerHTML).not.toContain('fixture-secret');
    expect(mcp.revealStoredOAuthCredential).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Edit')).toBe(false);
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show full URL')!);
    expect(mcp.revealStoredOAuthCredential).toHaveBeenCalledWith({ credentialId: 'a'.repeat(64) });
    expect(container.textContent!.replaceAll('\u200B', '')).toContain(secretUrl);
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Hide full URL')!);
    expect(container.outerHTML).not.toContain('fixture-secret');
    await click(container.querySelector('[aria-label="Clear credentials for former at https://a.example.test/… · aaaaaaaa"]')!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('https://a.example.test/… · aaaaaaaa');
    expect(document.body.outerHTML).not.toContain('fixture-secret');
    expect(mcp.revokeStoredOAuthCredential).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!);
    expect(mcp.revokeStoredOAuthCredential).not.toHaveBeenCalled();
    await click(container.querySelector('[aria-label="Clear credentials for former at https://a.example.test/… · aaaaaaaa"]')!);
    await click(document.querySelector('[role="alertdialog"] button:last-child')!);
    expect(mcp.revokeStoredOAuthCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: 'a'.repeat(64) });
    expect(mcp.resetAuth).not.toHaveBeenCalled();
    expect(mcp.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain('https://b.example.test/…');
  });

  it('discards a late Reveal after Hide and does not print failed Reveal details', async () => {
    const saved = [{ credentialId: 'c'.repeat(64), serverName: 'former', displayUrl: 'https://host.example.test/…', origin: 'unknown' }];
    mcp.listStoredOAuthCredentials.mockResolvedValue(saved);
    let resolve!: (value: { canonicalUrl: string }) => void;
    mcp.revealStoredOAuthCredential.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockRejectedValueOnce(new Error('fixture-secret'));
    const container = await render([]);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show full URL')!);
    expect(container.textContent).toContain('Loading URL…');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Hide full URL')!);
    await act(async () => { resolve({ canonicalUrl: 'https://user:fixture-secret@host.example.test/path?key=fixture-secret' }); await Promise.resolve(); });
    expect(container.outerHTML).not.toContain('fixture-secret');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show full URL')!);
    expect(container.textContent).toContain('Could not show this URL');
    expect(container.outerHTML).not.toContain('fixture-secret');
  });

  it('refreshes rotating ids after stale Reveal and revoke without retrying a destructive action', async () => {
    const identity = (letter: string) => ({
      credentialId: letter.repeat(64), serverName: 'former', displayUrl: 'https://pin.example.test/…', origin: 'unknown',
    });
    mcp.listStoredOAuthCredentials.mockResolvedValueOnce([identity('d')])
      .mockResolvedValueOnce([identity('e')]).mockResolvedValue([identity('f')]);
    mcp.revealStoredOAuthCredential.mockRejectedValueOnce(new Error('expired credential id'))
      .mockResolvedValueOnce({ canonicalUrl: 'https://pin.example.test/mcp?pin=0000' });
    mcp.revokeStoredOAuthCredential.mockRejectedValueOnce(new Error('expired credential id'));
    const container = await render([]);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(container.textContent).toContain('Credential dddddddd');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show full URL')!);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mcp.revealStoredOAuthCredential).toHaveBeenCalledWith({ credentialId: 'd'.repeat(64) });
    expect(container.textContent).toContain('Credential eeeeeeee');
    expect(container.textContent).not.toContain('Credential dddddddd');
    expect(container.outerHTML).not.toContain('pin=0000');

    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show full URL')!);
    expect(mcp.revealStoredOAuthCredential).toHaveBeenLastCalledWith({ credentialId: 'e'.repeat(64) });
    expect(container.textContent!.replaceAll('\u200B', '')).toContain('pin=0000');
    await click(container.querySelector('[aria-label="Clear credentials for former at https://pin.example.test/… · eeeeeeee"]')!);
    await click(document.querySelector('[role="alertdialog"] button:last-child')!);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mcp.revokeStoredOAuthCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: 'e'.repeat(64) });
    expect(container.textContent).toContain('Credential ffffffff');
    expect(container.textContent).not.toContain('Credential eeeeeeee');
    expect(container.outerHTML).not.toContain('pin=0000');
    expect(container.textContent).toContain('Could not clear saved OAuth credentials');
    expect(container.textContent).not.toContain('expired credential id');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('offers a retry after the offline saved-credential inventory fails without guessing a target', async () => {
    mcp.listStoredOAuthCredentials.mockRejectedValueOnce(new Error('fixture offline')).mockResolvedValueOnce([]);
    const container = await render([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('Could not load saved OAuth credentials');
    expect(container.textContent).not.toContain('fixture offline');
    expect(container.textContent).not.toContain('Saved connection');
    expect(mcp.resetAuth).not.toHaveBeenCalled();
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry credential list')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('No saved OAuth credentials found.');
  });

  it('warns about the original name and URL when editing the identity, URL or transport', async () => {
    const container = await render([remote]);
    const fieldset = await openRemote(container);
    expect(fieldset.textContent).not.toContain('Changing the name, URL, or transport does not remove');
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://new.example.test/mcp');
    expect(fieldset.textContent).toContain('saved OAuth credentials for remote at https://old.example.test/mcp');
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://old.example.test/mcp');
    expect(fieldset.textContent).not.toContain('Changing the name, URL, or transport does not remove');
    await pickOption(fieldset.querySelector('[data-mcp-transport]')!, 'stdio');
    expect(fieldset.textContent).toContain('saved OAuth credentials for remote at https://old.example.test/mcp');
    await pickOption(fieldset.querySelector('[data-mcp-transport]')!, 'http');
    await change(fieldset.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com"]')!, 'https://old.example.test/mcp');
    await change(fieldset.querySelector<HTMLInputElement>('input')!, 'renamed');
    expect(fieldset.textContent).toContain('saved OAuth credentials for remote at https://old.example.test/mcp');
  });
});
