// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestIdentityCatalog, RequestIdentityProfile } from '@kiki/protocol';
import { I18nProvider, useI18n } from '../../i18n';
import { ConfirmDialog } from '../ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState } from '../dirtyGuard';
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
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function GuardHarness() {
  const { t } = useI18n();
  const location = useLocation();
  const rawNavigate = useNavigate();
  const guard = useDirtyGuardState(location, (target, options) => {
    if (typeof target === 'number') void rawNavigate(target);
    else void rawNavigate(target, options);
  });
  return <DirtyGuardContext.Provider value={guard.value}>
    <div data-page-dirty={String(guard.value.dirty)}>
      <button onClick={() => { guard.navigate('/other'); }}>Leave page</button>
      <button onClick={() => { guard.navigate('/'); }}>Return to identities</button>
      {location.pathname === '/' ? <IdentitySection /> : null}
    </div>
    <ConfirmDialog open={guard.pending} title={t('st.dirty.leaveTitle')} body={t('st.dirty.leaveBody')}
      confirmLabel={t('st.dirty.leaveConfirm')} cancelLabel={t('st.dirty.stay')}
      onConfirm={() => { void guard.confirm(); }} onCancel={guard.cancel} />
  </DirtyGuardContext.Provider>;
}

async function render(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<MemoryRouter><QueryClientProvider client={queryClient}><I18nProvider><GuardHarness /></I18nProvider></QueryClientProvider></MemoryRouter>);
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

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const FIRST: RequestIdentityProfile = { ...CODEX, id: 'custom:first', builtin: false, label: 'First', duplicated_from: 'codex' };
const SECOND: RequestIdentityProfile = { ...FIRST, id: 'custom:second', label: 'Second' };
const twoCustom = () => catalog({ profiles: [CODEX, FIRST, SECOND] });
const labelInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-identity-label]')!;
const footer = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-settings-draft^="identity-custom:"]')!;
async function select(container: HTMLElement, id: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`[data-identity-row="${id}"]`)!.click(); });
}

describe('IdentitySection', () => {
  it('1: retains the audit label draft across rows without a confirmation or save', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'REVIEW-DRAFT-NOT-SAVED');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-identity-back]')!.click(); });
    await select(container, 'codex');
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('REVIEW-DRAFT-NOT-SAVED');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('2: retains headers, params, UA, version, overrides text and the server rejection per identity', async () => {
    api.get.mockResolvedValue(twoCustom());
    api.updateProfile.mockRejectedValue(new Error('server rejected this identity'));
    const container = await render();
    await select(container, FIRST.id);
    await type(container.querySelector<HTMLInputElement>('[data-identity-user-agent]')!, 'draft/{version}');
    await type(container.querySelector<HTMLInputElement>('[data-identity-pairs="header"] input:nth-child(2)')!, 'private draft header');
    await act(async () => { button(container.querySelector('[data-identity-pairs="param"]')!, 'Add field').click(); });
    await type(container.querySelector<HTMLInputElement>('[data-identity-pairs="param"] input')!, 'draft-param');
    await type(container.querySelector<HTMLInputElement>('[data-identity-pairs="param"] input:nth-child(2)')!, 'draft-value');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-identity-version-mode="fixed"]')!.click(); });
    await type(container.querySelector<HTMLInputElement>('[data-identity-version]')!, ' 2.0.0 ');
    const json = '{  "lineage": { "thread_identity": "none" }  }\n';
    await type(container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!, json);
    await act(async () => { button(footer(container), 'Save').click(); });
    await settle();
    await select(container, SECOND.id);
    expect(container.querySelector('[data-field-issue]')).toBeNull();
    await select(container, FIRST.id);
    expect(container.querySelector<HTMLInputElement>('[data-identity-user-agent]')!.value).toBe('draft/{version}');
    expect(container.querySelector<HTMLInputElement>('[data-identity-pairs="header"] input:nth-child(2)')!.value).toBe('private draft header');
    expect(container.querySelector<HTMLInputElement>('[data-identity-pairs="param"] input')!.value).toBe('draft-param');
    expect(container.querySelector<HTMLInputElement>('[data-identity-pairs="param"] input:nth-child(2)')!.value).toBe('draft-value');
    expect(container.querySelector<HTMLInputElement>('[data-identity-version]')!.value).toBe(' 2.0.0 ');
    expect(container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!.value).toBe(json);
    expect(container.querySelector('[data-field-issue]')?.textContent).toContain('server rejected this identity');
  });

  it('3: saves only the selected identity and uses a real GET, not the update echo, as its baseline', async () => {
    api.get.mockResolvedValueOnce(twoCustom());
    api.updateProfile.mockResolvedValue(catalog({ profiles: [CODEX, { ...FIRST, label: 'Echo', user_agent: 'echo-UA' }, SECOND] }));
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, { ...FIRST, label: 'Normalized', user_agent: 'normalized-UA' }, SECOND] }));
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'Submitted');
    await act(async () => { button(footer(container), 'Save').click(); });
    await settle();
    expect(api.updateProfile).toHaveBeenCalledExactlyOnceWith(FIRST.id, expect.objectContaining({ label: 'Submitted' }));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.invocationCallOrder[1]).toBeGreaterThan(api.updateProfile.mock.invocationCallOrder[0]!);
    expect(labelInput(container).value).toBe('Normalized');
    expect(container.querySelector<HTMLInputElement>('[data-identity-user-agent]')!.value).toBe('normalized-UA');
    expect(button(footer(container), 'Discard changes').disabled).toBe(true);
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('false');
  });

  it('4: keeps the second identity draft intact when saving the first', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    await select(container, SECOND.id);
    await type(labelInput(container), 'Second draft');
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('First draft');
    const saved = catalog({ profiles: [CODEX, { ...FIRST, label: 'First saved' }, SECOND] });
    api.updateProfile.mockResolvedValue(saved);
    api.get.mockResolvedValue(saved);
    await act(async () => { button(footer(container), 'Save').click(); });
    await settle();
    expect(api.updateProfile).toHaveBeenCalledExactlyOnceWith(FIRST.id, expect.objectContaining({ label: 'First draft' }));
    expect(labelInput(container).value).toBe('First saved');
    await select(container, SECOND.id);
    expect(labelInput(container).value).toBe('Second draft');
    expect(button(footer(container), 'Discard changes').disabled).toBe(false);
  });

  it('5: discards only the selected draft, disables Discard when clean and clears dirtiness on an exact revert', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    await select(container, SECOND.id);
    await type(labelInput(container), 'Second draft');
    await select(container, FIRST.id);
    await act(async () => { button(footer(container), 'Discard changes').click(); });
    expect(labelInput(container).value).toBe(FIRST.label);
    expect(button(footer(container), 'Discard changes').disabled).toBe(true);
    await select(container, SECOND.id);
    expect(labelInput(container).value).toBe('Second draft');
    await type(labelInput(container), SECOND.label);
    expect(button(footer(container), 'Discard changes').disabled).toBe(true);
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('false');
  });

  it('6: retains invalid JSON and its field issue only on its identity and blocks its save', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!, '{ invalid');
    await act(async () => { button(footer(container), 'Save').click(); });
    const issue = container.querySelector('[data-field-issue]')!.textContent;
    await select(container, SECOND.id);
    expect(container.querySelector('[data-field-issue]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!.value).toBe('');
    await select(container, FIRST.id);
    expect(container.querySelector<HTMLTextAreaElement>('[data-identity-overrides]')!.value).toBe('{ invalid');
    expect(container.querySelector('[data-field-issue]')!.textContent).toBe(issue);
    expect(container.querySelector('[data-identity-overrides]')!.getAttribute('aria-invalid')).toBe('true');
    await act(async () => { button(footer(container), 'Save').click(); });
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('guards leaving with off-selected drafts, cancels without loss and discards all drafts on leave', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    await select(container, SECOND.id);
    await type(labelInput(container), 'Second draft');
    await select(container, 'codex');
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('true');
    await act(async () => { button(container, 'Leave page').click(); });
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await act(async () => { button(document.body, 'Keep editing').click(); });
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('First draft');
    await select(container, 'codex');
    await act(async () => { button(container, 'Leave page').click(); });
    await act(async () => { button(document.body, 'Discard and leave').click(); });
    expect(container.querySelector('[data-identity-detail]')).toBeNull();
    await act(async () => { button(container, 'Return to identities').click(); });
    await settle();
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe(FIRST.label);
    await select(container, SECOND.id);
    expect(labelInput(container).value).toBe(SECOND.label);
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('false');
  });

  it('duplicates without losing the source draft and drops only the deleted identity draft', async () => {
    api.get.mockResolvedValue(twoCustom());
    const created: RequestIdentityProfile = { ...FIRST, id: 'custom:copy', label: 'Created copy', duplicated_from: FIRST.id };
    api.duplicateProfile.mockResolvedValue(catalog({ profiles: [CODEX, FIRST, SECOND, created] }));
    const container = await render();
    await select(container, SECOND.id);
    await type(labelInput(container), 'Second draft');
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    await act(async () => { button(container.querySelector('[data-identity-detail]')!, 'Duplicate to edit').click(); });
    await settle();
    expect(container.querySelector('[data-identity-detail]')!.getAttribute('data-identity-detail')).toBe(created.id);
    expect(labelInput(container).value).toBe(created.label);
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('First draft');
    api.deleteProfile.mockResolvedValue(catalog({ profiles: [CODEX, SECOND, created] }));
    await act(async () => { button(container, 'Delete identity').click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle();
    expect(container.querySelector('[data-identity-detail="codex"]')).not.toBeNull();
    expect(container.querySelector(`[data-identity-row="${FIRST.id}"]`)).toBeNull();
    await select(container, SECOND.id);
    expect(labelInput(container).value).toBe('Second draft');
    await act(async () => { button(footer(container), 'Discard changes').click(); });
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('false');
  });

  it('keeps the exact draft and its error when the authoritative read-back fails', async () => {
    api.get.mockResolvedValue(twoCustom());
    api.updateProfile.mockResolvedValue(twoCustom());
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    api.get.mockRejectedValue(new Error('read-back failed'));
    await act(async () => { button(footer(container), 'Save').click(); });
    await settle();
    await select(container, 'codex');
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('First draft');
    expect(container.querySelector('[data-field-issue]')?.textContent).toContain('read-back failed');
    expect(button(footer(container), 'Discard changes').disabled).toBe(false);
  });

  it('does not overwrite edits made while a save is in flight, even across a row switch', async () => {
    api.get.mockResolvedValue(twoCustom());
    let resolveUpdate!: (value: RequestIdentityCatalog) => void;
    api.updateProfile.mockReturnValue(new Promise<RequestIdentityCatalog>((resolve) => { resolveUpdate = resolve; }));
    const container = await render();
    await select(container, FIRST.id);
    await type(labelInput(container), 'Submitted draft');
    await act(async () => { button(footer(container), 'Save').click(); });
    await select(container, SECOND.id);
    await type(labelInput(container), 'Second draft');
    await select(container, FIRST.id);
    await type(labelInput(container), 'Newer first draft');
    const normalized = catalog({ profiles: [CODEX, { ...FIRST, label: 'Normalized submitted draft' }, SECOND] });
    api.get.mockResolvedValue(normalized);
    await act(async () => { resolveUpdate(normalized); });
    await settle();
    expect(labelInput(container).value).toBe('Newer first draft');
    await select(container, SECOND.id);
    expect(labelInput(container).value).toBe('Second draft');
    await select(container, FIRST.id);
    await act(async () => { button(footer(container), 'Discard changes').click(); });
    expect(labelInput(container).value).toBe('Normalized submitted draft');
  });

  it('retains drafts when a background catalog refresh fails', async () => {
    api.get.mockResolvedValue(twoCustom());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await render(queryClient);
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    api.get.mockRejectedValue(new Error('refresh failed'));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['request-identity'], exact: true }); });
    await settle();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(labelInput(container).value).toBe('First draft');
    await select(container, 'codex');
    await select(container, FIRST.id);
    expect(labelInput(container).value).toBe('First draft');
    expect(container.querySelector('[data-page-dirty]')!.getAttribute('data-page-dirty')).toBe('true');
  });

  it('marks the drafted identity in the directory and nothing else', async () => {
    api.get.mockResolvedValue(twoCustom());
    const container = await render();
    const marker = (id: string) => container.querySelector(`[data-identity-row="${id}"] [data-identity-unsaved]`);
    expect(marker('codex')).toBeNull();
    await select(container, FIRST.id);
    await type(labelInput(container), 'First draft');
    expect(marker(FIRST.id)?.textContent).toBe('Unsaved');
    expect(marker(SECOND.id)).toBeNull();
    expect(marker('codex')).toBeNull();
    await act(async () => { button(footer(container), 'Discard changes').click(); });
    expect(marker(FIRST.id)).toBeNull();
  });

  it('names the preview and folds the full header list until asked', async () => {
    const container = await render();
    const preview = container.querySelector('[data-identity-preview]')!;
    expect(preview.querySelector('h4')!.textContent).toBe('Request preview');
    const details = preview.querySelector<HTMLDetailsElement>('[data-preview-details]')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('All headers and fields (2)');
    expect(preview.textContent).toContain('codex_cli_rs/0.159.2 (Linux 6.1; x86_64)');
    expect(preview.querySelector('[data-preview-version]')!.textContent)
      .toContain('0.159.2 (Codex CLI · Shipped with Kiki) · OpenAI Responses · sample model example-model');
    expect(details.querySelector('[data-preview-header="session-id"]')).not.toBeNull();
  });

  it('marks a preview of unsaved edits and says what is sent meanwhile', async () => {
    const copy: RequestIdentityProfile = { ...CODEX, id: 'custom:first', builtin: false, label: 'First' };
    api.get.mockResolvedValue(catalog({ profiles: [CODEX, copy] }));
    const container = await render();
    await select(container, copy.id);
    await type(labelInput(container), 'First draft');
    const preview = container.querySelector('[data-identity-preview]')!;
    expect(preview.querySelector('h4')!.textContent).toBe('Unsaved request preview');
    expect(preview.textContent).toContain('Requests keep using the saved identity until you save.');
    expect(preview.querySelector<HTMLDetailsElement>('[data-preview-details]')!.open).toBe(false);
  });

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
    api.updateProfile.mockImplementation(async (_id: string, draft: RequestIdentityProfile) => {
      const saved = catalog({ profiles: [CODEX, { ...copy, ...draft }] });
      api.get.mockResolvedValue(saved);
      return saved;
    });
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
    api.updateProfile.mockImplementation(async (_id: string, draft: RequestIdentityProfile) => {
      const saved = catalog({ profiles: [CODEX, { ...copy, ...draft }] });
      api.get.mockResolvedValue(saved);
      return saved;
    });
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
