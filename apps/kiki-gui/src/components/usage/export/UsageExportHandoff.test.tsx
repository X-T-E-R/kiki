// @vitest-environment jsdom

/**
 * The handoff state machine as a reader meets it: one consent with two stated
 * effects, five phases that are not progress bars, and a boundary that has
 * passed never described as a takeover.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageExportDestination, UsageExportHandoff } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { HandoffSection } from './UsageExportHandoff';

const HALF_HOUR = 1_800_000;
// The component is typed against the real facade; the test only needs these five
// methods, and keeps the rest of the contract out of the way.
const api = {
  handoff: vi.fn(), planHandoff: vi.fn(), armHandoff: vi.fn(), refreshHandoff: vi.fn(), rollbackHandoff: vi.fn(),
} as unknown as Parameters<typeof HandoffSection>[0]['api'];
const plan = api.planHandoff as unknown as ReturnType<typeof vi.fn>;
const arm = api.armHandoff as unknown as ReturnType<typeof vi.fn>;
const refresh = api.refreshHandoff as unknown as ReturnType<typeof vi.fn>;
const rollback = api.rollbackHandoff as unknown as ReturnType<typeof vi.fn>;

const FINGERPRINT = '9'.repeat(64);

const destination = (over: Partial<UsageExportDestination> = {}): UsageExportDestination => ({
  id: '44444444-4444-4444-8444-444444444444',
  label: 'vibecafe for this home only',
  target: { kind: 'vibe', endpoint: 'https://usage.example.test/api/usage/ingest' },
  account_fingerprint: 'a'.repeat(64),
  scope: { start_at: 1_800_000_000_000, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
  schedule_minutes: 30,
  stream_id: 'b'.repeat(48),
  enabled: false,
  consent_fingerprint: null,
  credential_storage: 'keyring',
  state: 'draft',
  next_at: null,
  last_success_at: null,
  error_category: null,
  ...over,
});

function handoff(over: Partial<UsageExportHandoff> = {}): UsageExportHandoff {
  return {
    schema_version: 'kiki.usage.handoff.v1',
    data_home_fingerprint: 'c'.repeat(64),
    account_fingerprint: 'a'.repeat(64),
    cutoff_at: Date.now() + 4 * HALF_HOUR,
    namespace: `kiki-${'d'.repeat(32)}`,
    phase: 'prepared',
    legacy_receipt: null,
    native_receipt: null,
    previous_cutoff_at: null,
    ...over,
  };
}

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

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(view: UsageExportHandoff | null, target = destination(), onSettled = vi.fn()) {
  // The same projection the panel uses, so the test sees the component's inputs.
  const { handoffViewOf } = await import('../../../lib/usageExport');
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await act(async () => {
    createRoot(container).render(
      <I18nProvider>
        <HandoffSection api={api} destination={target} view={handoffViewOf(view, target)} handoff={view} onHandoff={vi.fn()} onSettled={onSettled} />
      </I18nProvider>,
    );
  });
  await flush();
  return onSettled;
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const text = () => document.body.textContent ?? '';
function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  for (const mock of [plan, arm, refresh, rollback]) mock.mockReset();
  plan.mockResolvedValue(handoff());
  arm.mockResolvedValue(handoff({ phase: 'armed' }));
  refresh.mockResolvedValue(handoff({ phase: 'awaiting-native' }));
  rollback.mockResolvedValue(handoff({ phase: 'rollback-prepared' }));
});

describe('handoff phases', () => {
  it('offers the boundary and both effects when nothing is arranged', async () => {
    await render(null);
    expect(text()).toContain('No handoff has been arranged');
    expect(text()).toContain('stops covering this Kiki home from the boundary onward');
    expect(text()).toContain('queues anything it cannot send while offline');
    expect(text()).toContain('does not rewrite the collector’s state file');
    expect(q('[data-usage-export-handoff-arm]')).not.toBeNull();
  });

  it('does not call armed readiness a successful sync', async () => {
    await render(handoff({ phase: 'armed' }));
    expect(q('[data-usage-export-handoff-phase="armed"]')).not.toBeNull();
    expect(text()).toContain('Waiting for the first confirmations');
    expect(text()).toContain('This is not a successful sync yet.');
    // Nothing to do until a receipt arrives, so the arm control is gone.
    expect(q('[data-usage-export-handoff-arm]')).toBeNull();
  });

  it('waits for Kiki’s own receipt after the collector’s last one', async () => {
    await render(handoff({
      phase: 'awaiting-native',
      legacy_receipt: {
        completed_at: Date.now() - 60_000, cutoff_at: 1_800_000_000_000, ingested: 412,
        coverage_complete: true, cutoff_persisted: true, collector_version: 'fixture-collector',
        collector_identity: { apiUrl: 'https://usage.example.test', keyFingerprint: 'abcdef0123456789', ingest_endpoint: 'https://usage.example.test/api/usage/ingest' },
      },
    }));
    expect(text()).toContain('Waiting for Kiki’s first receipt');
    expect(text()).toContain('412 buckets');
    expect(text()).toContain('No Kiki receipt yet.');
  });

  it('reports completion only when both receipts are in', async () => {
    await render(handoff({
      phase: 'completed',
      legacy_receipt: {
        completed_at: Date.now() - 60_000, cutoff_at: 1_800_000_000_000, ingested: 412,
        coverage_complete: true, cutoff_persisted: true, collector_version: 'fixture-collector',
        collector_identity: { apiUrl: 'https://usage.example.test', keyFingerprint: 'abcdef0123456789', ingest_endpoint: 'https://usage.example.test/api/usage/ingest' },
      },
      native_receipt: { schema_version: 'kiki.usage.receipt.v1', batch_id: 'fx000000000000000000000000', items: [{ stream_id: 's', bucket_id: 'b', revision: 1, payload_hash: 'e'.repeat(64), status: 'applied' }] },
    }));
    expect(text()).toContain('Handoff complete');
    expect(text()).toContain('1 buckets confirmed');
  });

  it('asks for a new boundary when the prepared one has passed, and says the takeover did not happen', async () => {
    await render(handoff({ cutoff_at: Date.now() - 4 * HALF_HOUR }));
    expect(q('[data-usage-export-handoff-expired]')).not.toBeNull();
    expect(text()).toContain('Kiki has not taken over');
    expect(text()).toContain('no records were lost');
    expect(q('[data-usage-export-handoff-arm]')).not.toBeNull();
  });

  it('shows the configuration check before the collector file is accepted', async () => {
    await render(null);
    expect(text()).toContain('checks its boundary, namespace, destination endpoint and key fingerprint');
    expect(text()).toContain('nothing is replayed into the new namespace and nothing is deleted');
  });

  it('names the reporting namespace without an unsubstituted placeholder', async () => {
    await render(handoff());
    // A label template carrying {namespace} with no value renders the placeholder
    // itself; the namespace value belongs beside the label, not inside it.
    expect(text()).not.toContain('{namespace}');
    expect(text()).toContain('Reporting namespace');
    expect(text()).toContain(`kiki-${'d'.repeat(32)}`);
  });

  it('keeps the boundary, both receipts and the arm effects out in the open', async () => {
    await render(handoff());
    // These decide whether to hand over, so they are never behind a disclosure.
    const open = [...document.querySelectorAll('details')]
      .filter((node) => !(node as HTMLDetailsElement).open)
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(open).not.toContain('Cut-over boundary');
    expect(open).not.toContain('Old collector');
    expect(open).not.toContain('activating the cut-off');
    expect(q('[data-usage-export-handoff-cutoff-value]')!.closest('details')).toBeNull();
  });

  it('keeps the namespace and the identity mechanism behind one disclosure', async () => {
    await render(handoff());
    const technical = q('[data-usage-export-handoff-technical]') as HTMLDetailsElement;
    expect(technical).not.toBeNull();
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain(`kiki-${'d'.repeat(32)}`);
    expect(technical.textContent).toContain('compares the destination with the collector');
  });

  it('refuses a handoff from a destination that has already reported', async () => {
    await render(null, destination({ last_success_at: Date.now() - 3_600_000, enabled: true, state: 'ready' }));
    expect(q('[data-usage-export-handoff-inapplicable]')).not.toBeNull();
    expect(q('[data-usage-export-handoff-arm]')).toBeNull();
  });

  it('names the step that stopped when the arm is refused', async () => {
    plan.mockRejectedValue(new Error('handoff-requires-new-vibe-draft'));
    await render(null);
    await act(async () => { setValue(q<HTMLInputElement>('[data-usage-export-handoff-file]')!, '/home/collector/config.json'); });
    await flush();
    await act(async () => { q<HTMLButtonElement>('[data-usage-export-handoff-arm]')!.click(); });
    await flush();
    expect(q('[data-usage-export-handoff-error]')!.textContent).toContain('recording the boundary');
    expect(text()).toContain('handoff-requires-new-vibe-draft');
  });

  it('requires a collector file and a future boundary before arming', async () => {
    await render(null);
    await act(async () => { q<HTMLButtonElement>('[data-usage-export-handoff-arm]')!.click(); });
    await flush();
    expect(q('[data-usage-export-handoff-invalid]')!.textContent).toContain('Pick the collector file');
    expect(plan).not.toHaveBeenCalled();
    await act(async () => { setValue(q<HTMLInputElement>('[data-usage-export-handoff-file]')!, '/home/collector/config.json'); });
    await flush();
    // With a file but a boundary in the past, the same consent is still refused.
    await act(async () => { setValue(q<HTMLInputElement>('[data-usage-export-handoff-cutoff]')!, '2020-01-01T00:00'); });
    await flush();
    await act(async () => { q<HTMLButtonElement>('[data-usage-export-handoff-arm]')!.click(); });
    await flush();
    expect(q('[data-usage-export-handoff-invalid]')!.textContent).toContain('future');
    expect(plan).not.toHaveBeenCalled();
  });
});
