// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestIdentityCatalog, RequestIdentityProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { IdentitySection } from './IdentitySection';
import { optionLabels } from './testControls';

const api = {
  get: vi.fn(),
  preview: vi.fn(),
  duplicateProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  checkTrack: vi.fn(),
  applyTrack: vi.fn(),
  trackAction: vi.fn(),
  pinTrack: vi.fn(),
  setManifestUrl: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { requestIdentity: api, getConfig: async () => ({}), patchConfig: async () => ({}) } }),
}));

const AT = '2026-09-30T00:00:00.000Z';

const CODEX: RequestIdentityProfile = {
  id: 'codex', builtin: true, label: 'Codex CLI', base_preset: 'codex_compatible', track: 'codex_cli',
  version: { mode: 'track' }, user_agent: 'codex_cli_rs/{version} ({os_type} {os_version}; {arch})',
  headers: [{ name: 'originator', value: 'codex_cli_rs' }], params: [],
};

function catalog(patch: Partial<RequestIdentityCatalog> = {}): RequestIdentityCatalog {
  const track = (id: 'codex_cli' | 'claude_code' | 'grok_cli', version: string) => ({
    id, npm_package: `pkg-${id}`, cli_command: id,
    current: { version, origin: 'builtin' as const, at: AT },
    builtin: { version, origin: 'builtin' as const, at: AT },
    candidate: null, history: [], pinned: false, last_check: null,
  });
  return {
    profiles: [CODEX],
    tracks: [track('codex_cli', '0.159.2'), track('claude_code', '2.1.285'), track('grok_cli', '1.0.44')],
    manifest_url: null,
    usage: [{ scope: 'global', label: 'global', effective_profile: 'codex', effective_preset: 'codex_compatible' }],
    observations: [],
    ...patch,
  };
}

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue(catalog());
  api.preview.mockResolvedValue({
    headers: [
      { name: 'User-Agent', value: 'codex_cli_rs/0.159.2 (Linux 6.1; x86_64)', kind: 'static', origin: 'profile' },
      { name: 'session-id', value: '00000000-0000-4000-8000-000000000002', kind: 'per_request', origin: 'lineage' },
    ],
    params: {}, version: '0.159.2', version_origin: 'track:builtin', suppressed_user_agent: false,
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<MemoryRouter><QueryClientProvider client={queryClient}><I18nProvider><IdentitySection /></I18nProvider></QueryClientProvider></MemoryRouter>);
  });
  await settle();
  await settle();
  return container;
}

function button(container: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    typeof text === 'string' ? candidate.textContent?.trim() === text : text.test(candidate.textContent ?? ''));
  if (found === undefined) throw new Error(`no button ${String(text)}`);
  return found;
}

async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('IdentitySection', () => {
  it('renders an OpenCode built-in from the catalog and offers it in the global picker', async () => {
    const opencode: RequestIdentityProfile = {
      id: 'opencode', builtin: true, label: 'OpenCode', base_preset: 'opencode_compatible', track: 'opencode_cli',
      version: { mode: 'track' }, user_agent: 'opencode/{version}',
      headers: [{ name: 'x-opencode-client', value: 'cli' }], params: [],
    };
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, opencode] }));
    const container = await render();
    const row = container.querySelector<HTMLButtonElement>('[data-identity-row="opencode"]')!;
    expect(row.textContent).toContain('OpenCode');
    await act(async () => { row.click(); });
    await settle();
    expect(container.querySelector('[data-identity-detail="opencode"]')!.textContent).toContain('opencode/{version}');
    expect(api.preview).toHaveBeenCalledWith({ profile: 'opencode', protocol: 'openai_responses', model: 'example-model' });
    expect(await optionLabels(container.querySelector('[data-request-identity-choice]')!)).toContain('OpenCode-compatible');
  });

  it('shows a built-in identity read-only with the exact values it sends, unmasked', async () => {
    const container = await render();
    const detail = container.querySelector('[data-identity-detail="codex"]')!;
    expect(detail.textContent).toContain('Built-in identity. Duplicate to customize.');
    expect(detail.querySelector('input')).toBeNull();
    const ua = container.querySelector('[data-preview-header="User-Agent"]')!;
    expect(ua.textContent).toContain('codex_cli_rs/0.159.2 (Linux 6.1; x86_64)');
    expect(container.querySelector('[data-preview-header="session-id"]')!.textContent).toContain('per request');
    expect(api.preview).toHaveBeenCalledWith({ profile: 'codex', protocol: 'openai_responses', model: 'example-model' });
  });

  it('duplicates a built-in, then edits and saves the copy as a full draft', async () => {
    const copy: RequestIdentityProfile = { ...CODEX, id: 'custom:codex-1', builtin: false, label: 'Codex CLI (copy)', duplicated_from: 'codex' };
    api.duplicateProfile.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    api.updateProfile.mockImplementation(async (_id: string, draft: RequestIdentityProfile) =>
      catalog({ profiles: [CODEX, { ...copy, ...draft }] }));
    const container = await render();

    await act(async () => { button(container, 'Duplicate to edit').click(); });
    await settle();
    expect(api.duplicateProfile).toHaveBeenCalledWith('codex', 'Codex CLI (copy)');
    const ua = container.querySelector<HTMLInputElement>('[data-identity-user-agent]')!;
    expect(ua.value).toBe(CODEX.user_agent);

    await type(ua, 'codex-tui/{version} ({os_type} {os_version}; {arch}) WindowsTerminal');
    const footer = container.querySelector<HTMLElement>('[data-settings-draft="identity-custom:codex-1"]')!;
    expect(footer.hidden).toBe(false);
    await act(async () => { button(footer, 'Save').click(); });
    await settle();
    expect(api.updateProfile).toHaveBeenCalledWith('custom:codex-1', expect.objectContaining({
      user_agent: 'codex-tui/{version} ({os_type} {os_version}; {arch}) WindowsTerminal',
      headers: [{ name: 'originator', value: 'codex_cli_rs' }],
      version: { mode: 'track' },
    }));
  });

  it('preserves a fixed-version IME draft verbatim and trims only on save', async () => {
    const copy: RequestIdentityProfile = {
      ...CODEX, id: 'custom:codex-1', builtin: false, label: 'Mine', version: { mode: 'fixed', value: '1.0.0' },
    };
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    api.updateProfile.mockImplementation(async (_id: string, draft: RequestIdentityProfile) =>
      catalog({ profiles: [CODEX, { ...copy, ...draft }] }));
    const container = await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-identity-row="custom:codex-1"]')!.click(); });
    const input = container.querySelector<HTMLInputElement>('[data-identity-version]')!;
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' 2.0.0 ');
      input.setSelectionRange(2, 2);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    expect(input.value).toBe(' 2.0.0 ');
    expect(input.selectionStart).toBe(2);
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await act(async () => { button(container.querySelector('[data-settings-draft="identity-custom:codex-1"]')!, 'Save').click(); });
    await settle();
    expect(api.updateProfile).toHaveBeenCalledWith('custom:codex-1', expect.objectContaining({ version: { mode: 'fixed', value: '2.0.0' } }));
    expect(input.value).toBe('2.0.0');
  });

  it('keeps a server rejection under the editor instead of saving', async () => {
    const copy: RequestIdentityProfile = { ...CODEX, id: 'custom:codex-1', builtin: false, label: 'Mine' };
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    api.updateProfile.mockRejectedValue(new Error('unknown template variable {secret}'));
    const container = await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-identity-row="custom:codex-1"]')!.click(); });
    await type(container.querySelector<HTMLInputElement>('[data-identity-user-agent]')!, 'x/{secret}');
    await act(async () => { button(container.querySelector('[data-settings-draft="identity-custom:codex-1"]')!, 'Save').click(); });
    await settle();
    expect(container.querySelector('[data-field-issue]')?.textContent).toContain('unknown template variable {secret}');
  });

  it('stages a checked release and applies it only on an explicit click; pinning blocks apply', async () => {
    const staged = catalog();
    staged.tracks[0] = { ...staged.tracks[0]!, candidate: { version: '0.160.0', origin: 'npm', source_detail: '@openai/codex', at: AT } };
    api.checkTrack.mockResolvedValue(staged);
    api.applyTrack.mockResolvedValue(catalog());
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-identity-track="codex_cli"]')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-track-check="npm"]')!.click(); });
    await settle();
    expect(api.checkTrack).toHaveBeenCalledWith('codex_cli', 'npm');
    expect(api.applyTrack).not.toHaveBeenCalled();
    expect(row.querySelector('[data-track-current]')!.textContent).toBe('0.159.2');
    await act(async () => { button(row, 'Use 0.160.0').click(); });
    expect(api.applyTrack).toHaveBeenCalledWith('codex_cli', '0.160.0');

    const pinned = catalog();
    pinned.tracks[0] = { ...staged.tracks[0]!, pinned: true };
    api.get.mockResolvedValue(pinned);
    const again = await render();
    const pinnedRow = again.querySelector<HTMLElement>('[data-identity-track="codex_cli"]')!;
    expect(button(pinnedRow, 'Use 0.160.0').disabled).toBe(true);
    expect(pinnedRow.textContent).toContain('Pinned. Unpin to apply');
  });

  it('blocks a save when behavior overrides are not a JSON object, and sends parsed overrides otherwise', async () => {
    const copy: RequestIdentityProfile = { ...CODEX, id: 'custom:codex-1', builtin: false, label: 'Mine' };
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    api.updateProfile.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    const container = await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-identity-row="custom:codex-1"]')!.click(); });
    const overrides = container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!;
    const setText = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(overrides, value);
      overrides.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = () => act(async () => { button(container.querySelector('[data-settings-draft="identity-custom:codex-1"]')!, 'Save').click(); });
    await setText('[1, 2]');
    await save();
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(overrides.getAttribute('aria-invalid')).toBe('true');
    await setText('{ "lineage": { "thread_identity": "none" } }');
    await save();
    await settle();
    expect(api.updateProfile).toHaveBeenCalledWith('custom:codex-1', expect.objectContaining({ overrides: { lineage: { thread_identity: 'none' } } }));
  });

  it('shows the applied track templates on a built-in and rolls back on request', async () => {
    const updated = catalog();
    updated.tracks[0] = {
      ...updated.tracks[0]!,
      current: { version: '0.160.0', origin: 'manifest', source_detail: 'https://example.test/m.json', at: AT, headers: [{ name: 'originator', value: 'codex_exec' }] },
      history: [{ version: '0.159.2', origin: 'builtin', at: AT }],
    };
    api.get.mockResolvedValue(updated);
    api.trackAction.mockResolvedValue(catalog());
    const container = await render();
    expect(container.querySelector('[data-identity-detail="codex"]')!.textContent).toContain('originator: codex_exec');
    const row = container.querySelector<HTMLElement>('[data-identity-track="codex_cli"]')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-track-rollback]')!.click(); });
    expect(api.trackAction).toHaveBeenCalledWith('codex_cli', 'rollback');
  });

  it('lists where each identity is used and what the last request sent', async () => {
    api.get.mockResolvedValue(catalog({
      observations: [{
        at: AT, provider_id: 'openai', model: 'gpt-example', protocol: 'openai_responses', profile: 'codex',
        preset: 'codex_compatible', session_id: 's', agent_id: 'main',
        headers: [{ name: 'User-Agent', value: 'codex_cli_rs/0.159.2 (Linux 6.1; x86_64)' }],
        params: {}, suppressed_user_agent: false,
      }],
    }));
    const container = await render();
    expect(container.querySelector('[data-identity-usage="global"]')!.textContent).toContain('Codex CLI');
    const observation = container.querySelector('[data-identity-observation]')!;
    expect(observation.textContent).toContain('openai · gpt-example');
    expect(observation.textContent).toContain('codex_cli_rs/0.159.2 (Linux 6.1; x86_64)');
  });
});
