// @vitest-environment jsdom

/**
 * The behaviours a person can be hurt by if they break: cancelling sends
 * nothing, consent carries the fingerprint the server issued, one destination's
 * failure stays inside that destination, and a late reply from another
 * server/home never lands in the new one.
 */

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageExportDestination, UsageExportItem, UsageExportPreview, UsageExportStatus } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { UsageExportPanel } from './UsageExportPanel';

const usageExport = {
  status: vi.fn(), saveDraft: vi.fn(), preview: vi.fn(), testProtocol: vi.fn(), enable: vi.fn(),
  disable: vi.fn(), remove: vi.fn(), syncNow: vi.fn(), backfill: vi.fn(), diagnostics: vi.fn(),
  exportLocal: vi.fn(), rebuild: vi.fn(), retry: vi.fn(), setQueueCapacity: vi.fn(),
  clearQueue: vi.fn(), withdraw: vi.fn(),
};
const meta = vi.fn();
const listWorkspaces = vi.fn();

let scopeId = 'home-a';
let currentMeta: Record<string, unknown> = { server_home_id: 'home-a' };

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({
    client: { meta, listWorkspaces },
    klient: { rest: { usageExport } },
    scopeId,
    meta: currentMeta,
    config: { url: '', token: '' },
    sshLabel: null,
  }),
}));

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  act_.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
});
afterAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const HALF_HOUR = 1_800_000;
const START = 1_800_000_000_000;
const FINGERPRINT = 'c'.repeat(64);

function destination(over: Partial<UsageExportDestination> = {}): UsageExportDestination {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'vibecafe personal',
    target: { kind: 'vibe', endpoint: 'https://vibecafe.example.test/api/usage/ingest' },
    account_fingerprint: 'a'.repeat(64),
    scope: { start_at: START, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
    schedule_minutes: 30,
    stream_id: 'b'.repeat(48),
    enabled: true,
    consent_fingerprint: FINGERPRINT,
    credential_storage: 'keyring',
    state: 'ready',
    next_at: START + 600_000,
    last_success_at: START,
    error_category: null,
    ...over,
  };
}

function status(...destinations: readonly UsageExportDestination[]): UsageExportStatus {
  return {
    writer: true,
    scan_complete: true,
    scan_error: null,
    destinations: destinations.map((item) => ({
      destination: item,
      queue: { pending: 0, inflight: 0, quarantined: 0, bytes: 0, limit_bytes: 52_428_800, warning: false, oldest_at: null },
    })),
  };
}

function item(start = START): UsageExportItem {
  return {
    schema_version: 'kiki.usage.bucket.v1',
    stream_id: 'b'.repeat(48),
    bucket_id: 'd'.repeat(48),
    revision: 1,
    payload_hash: 'e'.repeat(64),
    operation: 'replace',
    bucket: {
      start_at: new Date(start).toISOString(),
      end_at: new Date(start + HALF_HOUR).toISOString(),
      source: 'kiki',
      model: 'kimi-k2-thinking',
      mapping_version: 'kiki-public-model-v1',
      tokens: { input_other: 100, input_cache_read: 900, input_cache_creation: 20, output: 50 },
      quality: { known_records: 3, missing_records: 1, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true },
      cost: { usd_estimated: 0.0123, currency: 'USD', source: 'kiki-local-estimate', pricing_version: 'f'.repeat(64) },
    },
  };
}

function preview(destinationValue = destination()): UsageExportPreview {
  return {
    destination: destinationValue,
    preview_fingerprint: '9'.repeat(64),
    items: [item()],
    total_buckets: 1,
    source_complete: true,
    invalid_records: 0,
    disclosures: ['Only UTC half-hour model/token/quality/cost buckets are exported.'],
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function Harness({ bump }: { readonly bump?: (fn: () => void) => void }) {
  const [, force] = useState(0);
  bump?.((() => { force((n) => n + 1); }));
  return <UsageExportPanel />;
}

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <I18nProvider><Harness bump={(fn) => { forceRef = fn; }} /></I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

let forceRef: (() => void) | null = null;

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-usage-export-destination="${id}"] [data-usage-export-row]`)!;
const detail = (id: string) => document.querySelector<HTMLElement>(`[data-usage-export-detail="${id}"]`)!;
async function click(element: Element | null) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { setValue(input, value); });
  await flush();
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  for (const mock of Object.values(usageExport)) mock.mockReset();
  meta.mockReset();
  listWorkspaces.mockReset();
  scopeId = 'home-a';
  currentMeta = { server_home_id: 'home-a' };
  meta.mockResolvedValue({ server_home_id: 'home-a', experimental_flags: { usage_export: true } });
  listWorkspaces.mockResolvedValue({ items: [] });
  usageExport.status.mockResolvedValue(status(destination()));
  usageExport.saveDraft.mockResolvedValue(destination({ enabled: false, state: 'draft', consent_fingerprint: null }));
  usageExport.preview.mockResolvedValue(preview());
  usageExport.testProtocol.mockResolvedValue({ outcome: 'delivered', error_category: null });
  usageExport.enable.mockResolvedValue(destination());
  usageExport.disable.mockResolvedValue(destination({ enabled: false, state: 'disabled', next_at: null }));
  usageExport.remove.mockResolvedValue({ removed: true });
  usageExport.syncNow.mockResolvedValue(status(destination()));
  usageExport.clearQueue.mockResolvedValue(status(destination()));
  usageExport.withdraw.mockResolvedValue(status(destination()));
  usageExport.retry.mockResolvedValue(status(destination()));
  usageExport.rebuild.mockResolvedValue(status(destination()));
  usageExport.diagnostics.mockResolvedValue(status(destination()));
  usageExport.exportLocal.mockResolvedValue({ schema_version: 'kiki.usage.local-export.v1', items: [] });
  usageExport.setQueueCapacity.mockResolvedValue(status(destination()));
  usageExport.backfill.mockResolvedValue(preview());
});

describe('UsageExportPanel gating', () => {
  it('reports the feature as unavailable when the server never registered the routes', async () => {
    meta.mockResolvedValue({ server_home_id: 'home-a', experimental_flags: { usage_export: false } });
    await render();
    expect(q('[data-usage-export-unavailable]')).not.toBeNull();
    expect(usageExport.status).not.toHaveBeenCalled();
    // An empty destination list would be a lie: the routes do not exist.
    expect(q('[data-usage-export-empty]')).toBeNull();
  });

  it('renders destinations read-only when another instance is the writer', async () => {
    usageExport.status.mockResolvedValue({ ...status(destination()), writer: false });
    await render();
    expect(q('[data-usage-export-readonly]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-usage-export-add]')!.disabled).toBe(true);
    await click(row(ID_A));
    expect(q<HTMLButtonElement>('[data-usage-export-remove]')!.disabled).toBe(true);
  });
});

describe('opening and abandoning the form', () => {
  it('sends nothing when the form is opened and closed without saving', async () => {
    await render();
    await click(q('[data-usage-export-add]'));
    const name = q<HTMLInputElement>('[data-usage-export-form-name]')!;
    await type(name, 'my receiver');
    await click(q('[data-usage-export-form-cancel]'));
    expect(usageExport.status).toHaveBeenCalledTimes(1);
    for (const call of ['saveDraft', 'preview', 'testProtocol', 'enable', 'syncNow', 'backfill']) {
      expect(usageExport[call as keyof typeof usageExport]).not.toHaveBeenCalled();
    }
  });
});

describe('consent', () => {
  it('enables with the fingerprint the server issued for the previewed payload', async () => {
    await render();
    await click(q('[data-usage-export-add]'));
    const form = q<HTMLFormElement>('form [data-usage-export-form-preview]')!.closest('form')!;
    await type(q<HTMLInputElement>('[data-usage-export-form-name]')!, 'my receiver');
    await type(q<HTMLInputElement>('[data-usage-export-form-endpoint]')!, 'https://usage.example.test/ingest');
    await act(async () => { form.requestSubmit(); });
    await flush();

    // Preview is shown, and consent is bound to the fingerprint it returned.
    expect(q('[data-usage-export-preview-block]')).not.toBeNull();
    // The hash itself is folded; the consequence of changing the payload is not.
    const fingerprint = q('[data-usage-export-preview-fingerprint]')!;
    const binding = fingerprint.closest('details') as HTMLDetailsElement;
    expect(binding.open).toBe(false);
    expect(fingerprint.getAttribute('title')).toBe('9'.repeat(64));
    const visible = q('[data-usage-export-preview-block]')!
      .cloneNode(true) as HTMLElement;
    visible.querySelectorAll('details').forEach((node) => node.remove());
    expect(visible.textContent).toContain('Changing the endpoint, the credential identity or the range needs a new preview');
    expect(visible.textContent).not.toContain('9'.repeat(24));
    await click(q('[data-usage-export-form-enable]'));
    expect(usageExport.enable).toHaveBeenCalledTimes(1);
    expect(usageExport.enable.mock.calls[0]![1]).toEqual({ preview_fingerprint: '9'.repeat(64), acknowledge: true });
  });

  it('refuses to enable after the form changed, until the payload is previewed again', async () => {
    await render();
    await click(q('[data-usage-export-add]'));
    await type(q<HTMLInputElement>('[data-usage-export-form-name]')!, 'my receiver');
    await type(q<HTMLInputElement>('[data-usage-export-form-endpoint]')!, 'https://usage.example.test/ingest');
    await act(async () => { q<HTMLFormElement>('form:has([data-usage-export-form-preview])')!.requestSubmit(); });
    await flush();
    await type(q<HTMLInputElement>('[data-usage-export-form-name]')!, 'renamed');
    // The preview is still on screen, but it no longer describes what would be
    // sent: the consent is refused, and the reason is shown.
    expect(q('[data-usage-export-preview-stale]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-usage-export-form-enable]')!.disabled).toBe(true);
    await click(q('[data-usage-export-form-enable]'));
    expect(usageExport.enable).not.toHaveBeenCalled();
  });

  it('hands a script its approved command and keeps the timeout in advanced', async () => {
    await render();
    await click(q('[data-usage-export-add]'));
    await type(q<HTMLInputElement>('[data-usage-export-form-name]')!, 'my receiver');
    await click(document.querySelector('[data-axis="export-kind"] [data-axis-value="script"]'));
    expect(q('[data-usage-export-form-script-note]')!.textContent).toContain('as your OS user');
    expect(q('[data-usage-export-form-script-note]')!.textContent).toContain('not a sandbox');
    await type(q<HTMLTextAreaElement>('[data-usage-export-form-command]')!, 'receiver --json');
    await act(async () => { q<HTMLFormElement>('form:has([data-usage-export-form-preview])')!.requestSubmit(); });
    await flush();
    const saved = usageExport.saveDraft.mock.calls.at(-1)![0];
    expect(saved.draft.target).toEqual({ kind: 'script', command: 'receiver --json', timeout_ms: 10_000, output_limit_bytes: 65_536 });
    // A script has no credential, so the form never asks for a key and the
    // build carries an absent one rather than an empty string.
    expect(saved.secret).toBeUndefined();
    expect(q('[data-usage-export-form-secret]')).toBeNull();
  });
});

describe('a destination failure stays inside its own row', () => {
  it('shows the refusal in the row that failed and leaves the other row alone', async () => {
    usageExport.status.mockResolvedValue(status(destination({ id: ID_A, label: 'first' }), destination({ id: ID_B, label: 'second' })));
    await render();
    await click(row(ID_A));
    usageExport.syncNow.mockRejectedValue(new Error('usage-export-operation-failed'));
    await click(q('[data-usage-export-sync]'));
    expect(detail(ID_A).textContent).toContain('usage-export-operation-failed');
    expect(row(ID_B).textContent).toContain('second');
    await click(row(ID_B));
    expect(detail(ID_B).querySelector('[data-feedback-tone="error"]')).toBeNull();
  });

  it('keeps a paused destination and its queue, and says the recorded reason once', async () => {
    usageExport.status.mockResolvedValue({
      ...status(destination({ enabled: false, state: 'needs-auth', next_at: null, error_category: 'http_auth' })),
      destinations: [{
        destination: destination({ enabled: false, state: 'needs-auth', next_at: null, error_category: 'http_auth' }),
        queue: { pending: 12, inflight: 1, quarantined: 0, bytes: 4096, limit_bytes: 52_428_800, warning: false, oldest_at: START },
      }],
    });
    await render();
    expect(row(ID_A).textContent).toContain('13 buckets');
    await click(row(ID_A));
    // The recovery line already says the service refused the credential, so the
    // category sentence is not repeated underneath it.
    const recovery = q('[data-usage-export-recovery]')!.textContent!;
    expect(recovery).toContain('The service refused the stored credential.');
    expect(recovery).not.toContain('The service rejected the credential.');
    expect(q('[data-usage-export-resume]')).not.toBeNull();
    // Resuming re-presents the consent the server already recorded.
    await click(q('[data-usage-export-resume]'));
    expect(usageExport.enable.mock.calls[0]![1]).toEqual({ preview_fingerprint: FINGERPRINT, acknowledge: true });
  });

  it('asks before discarding unsent buckets when removing', async () => {
    usageExport.status.mockResolvedValue({
      ...status(destination()),
      destinations: [{
        destination: destination({ enabled: false, state: 'disabled' }),
        queue: { pending: 4, inflight: 0, quarantined: 0, bytes: 1000, limit_bytes: 52_428_800, warning: false, oldest_at: START },
      }],
    });
    await render();
    await click(row(ID_A));
    await click(q('[data-usage-export-remove]'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('4 unsent buckets will be discarded');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await flush();
    expect(usageExport.remove).toHaveBeenCalledWith(ID_A, true);
    // Pausing is not removing: the two actions never collapse into one.
    expect(usageExport.withdraw).not.toHaveBeenCalled();
  });

  it('keeps a category that adds a reason the recovery line does not carry', async () => {
    usageExport.status.mockResolvedValue({
      ...status(destination({ enabled: false, state: 'needs-auth', next_at: null, error_category: 'http_rate_limited' })),
      destinations: [{
        destination: destination({ enabled: false, state: 'needs-auth', next_at: null, error_category: 'http_rate_limited' }),
        queue: { pending: 0, inflight: 0, quarantined: 0, bytes: 0, limit_bytes: 52_428_800, warning: false, oldest_at: START },
      }],
    });
    await render();
    await click(row(ID_A));
    const recovery = q('[data-usage-export-recovery]')!.textContent!;
    expect(recovery).toContain('Replace the key');
    expect(recovery).toContain('asked Kiki to slow down');
  });

  it('names a category it has no sentence for rather than hiding it', async () => {
    const unknown = 'some_future_failure';
    usageExport.status.mockResolvedValue({
      ...status(destination({ enabled: false, state: 'retrying', next_at: null, error_category: unknown })),
      destinations: [{
        destination: destination({ enabled: false, state: 'retrying', next_at: null, error_category: unknown }),
        queue: { pending: 0, inflight: 0, quarantined: 0, bytes: 0, limit_bytes: 52_428_800, warning: false, oldest_at: START },
      }],
    });
    await render();
    await click(row(ID_A));
    expect(q('[data-usage-export-recovery]')!.textContent).toContain(unknown);
  });

  it('keeps the credential identity behind a disclosure but the decision facts open', async () => {
    await render();
    await click(row(ID_A));
    // How the credential is identified is for troubleshooting, so it is folded.
    const identity = q('[data-usage-export-identity]') as HTMLDetailsElement;
    expect(identity).not.toBeNull();
    expect(identity.open).toBe(false);
    expect(identity.textContent).toContain('not a verified account at the service');
    // What the person is actually agreeing to stays visible without a click.
    const closed = [...document.querySelectorAll('details')]
      .filter((node) => !(node as HTMLDetailsElement).open)
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(closed).not.toContain('Endpoint');
    expect(closed).not.toContain('Private file on the server');
    expect(closed).not.toContain('Agreed for this configuration');
    expect(q('[data-usage-export-detail-credential]')!.closest('details')).toBeNull();
    expect(q('[data-usage-export-detail-consent]')!.closest('details')).toBeNull();
  });
});

describe('a scope switch', () => {
  it('does not paint a late failure from the previous server and home', async () => {
    await render();
    await click(row(ID_A));
    let reject: ((error: Error) => void) | undefined;
    usageExport.syncNow.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await act(async () => { q<HTMLButtonElement>('[data-usage-export-sync]')!.click(); });
    scopeId = 'home-b';
    currentMeta = { server_home_id: 'home-b' };
    await act(async () => { forceRef?.(); });
    await flush();
    await act(async () => { reject!(new Error('stale failure from home-a')); });
    await flush();
    expect(document.body.textContent).not.toContain('stale failure from home-a');
  });
});

describe('the empty state', () => {
  it('names the three exits and the add entry without service cards', async () => {
    usageExport.status.mockResolvedValue(status());
    await render();
    const empty = q('[data-usage-export-empty]')!;
    expect(empty.textContent).toContain('vibecafe.ai');
    expect(empty.textContent).toContain('webhook');
    expect(empty.textContent).toContain('script');
    expect(q('[data-usage-export-empty-add]')).not.toBeNull();
    expect(q('[data-usage-export-source-note]')!.textContent).toContain('Only this server’s own usage');
  });
});
