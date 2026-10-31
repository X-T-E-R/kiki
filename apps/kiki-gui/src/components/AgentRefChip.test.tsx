// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import type { AgentReference } from '@kiki/transcript';

import { I18nProvider } from '../i18n';
import { executorCatalogQueryKey } from './settings/profileEditor/engines';
import { AgentRefResolutionProvider, AgentRefText } from './AgentRefChip';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const MESSAGE_ID = 'msg-1';

function reference(profile: string, refId = `ar:${MESSAGE_ID}:${profile}`): AgentReference {
  return { refId, profile, executor: 'native', configuration: 'native', label: profile };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    session_id: 'session_1',
    kind: 'subagent',
    description: 'Delegate',
    status: 'running',
    created_at: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

async function render(
  text: string,
  options: {
    references?: readonly AgentReference[];
    tasks?: readonly Task[];
    onOpenAgent?: (agentId: string) => void;
    messageId?: string;
    /** Engine catalog entries (`GET /executors` items) the chip reads engine labels from. */
    executors?: readonly { readonly id: string; readonly label: string }[];
  } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.executors !== undefined) {
    client.setQueryData(executorCatalogQueryKey('', undefined), { items: options.executors });
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <AgentRefResolutionProvider value={{ tasks: options.tasks ?? [], onOpenAgent: options.onOpenAgent }}>
            <AgentRefText
              text={text}
              references={options.references ?? []}
              messageId={options.messageId ?? MESSAGE_ID}
              projectSegment={(segment) => segment}
            />
          </AgentRefResolutionProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('AgentRefText', () => {
  it('renders a kiki://agents link as a chip with the profile and engine readable', async () => {
    const container = await render('delegate to kiki://agents/worker now', { references: [reference('worker')] });
    const chip = container.querySelector('[data-agent-ref-chip]')!;
    expect(chip.textContent).toContain('worker');
    expect(chip.textContent).toContain('native engine');
    expect(container.textContent).toContain('delegate to');
    expect(container.textContent).toContain('now');
  });

  it('opens the delegated child run when the reference produced a task', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const delegated = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-child-1' });
    const container = await render('use kiki://agents/worker', {
      references: [ref],
      tasks: [delegated],
      onOpenAgent,
    });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-status')).toBe('delegated');
    expect(chip.getAttribute('data-agent-ref-agent')).toBe('agent-child-1');
    await act(async () => { chip.click(); });
    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith('agent-child-1');
  });

  it('matches the run by message id when several messages reference the same profile', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const otherMessage = task({ id: 'task-other', source_ref: { ...ref, messageId: 'msg-other' }, agent_id: 'agent-other' });
    const ownMessage = task({ id: 'task-own', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-own' });
    const container = await render('use kiki://agents/worker', {
      references: [ref],
      tasks: [otherMessage, ownMessage],
      onOpenAgent,
    });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-agent')).toBe('agent-own');
    await act(async () => { chip.click(); });
    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith('agent-own');
  });

  it('shows not-delegated-yet when no task names the ref, and does not navigate', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const container = await render('use kiki://agents/worker', { references: [ref], tasks: [], onOpenAgent });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-status')).toBe('pending');
    expect(chip.getAttribute('aria-label')).toContain('Not delegated yet');
    await act(async () => { chip.click(); });
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it('shows a rejected delegation when the run never started, and does not navigate', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const failed = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: undefined, status: 'failed' });
    const container = await render('use kiki://agents/worker', { references: [ref], tasks: [failed], onOpenAgent });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-status')).toBe('rejected');
    expect(chip.getAttribute('aria-label')).toContain('Delegation did not start a run');
    await act(async () => { chip.click(); });
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it('renders a hand-typed link with no structured reference as not delegated yet', async () => {
    const onOpenAgent = vi.fn();
    const container = await render('try kiki://agents/ghost', { references: [], tasks: [], onOpenAgent });
    const chip = container.querySelector<HTMLElement>('[data-agent-ref-chip]')!;
    expect(chip.textContent).toContain('ghost');
    expect(chip.getAttribute('data-agent-ref-status')).toBe('pending');
    await act(async () => { chip.click(); });
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it('chips several references in one message in order', async () => {
    const refs = [reference('alpha'), reference('beta')];
    const container = await render('run kiki://agents/alpha then kiki://agents/beta', { references: refs });
    const chips = [...container.querySelectorAll('[data-agent-ref-chip]')];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('alpha');
    expect(chips[1]!.textContent).toContain('beta');
  });

  it('marks a rejected chip in words, not by dot colour alone', async () => {
    const ref = reference('worker');
    const failed = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: undefined, status: 'failed' });
    const container = await render('use kiki://agents/worker', { references: [ref], tasks: [failed] });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-status')).toBe('rejected');
    expect(chip.textContent).toContain('not started');
    expect(chip.querySelector('.line-through')).not.toBeNull();
  });

  it('reads the engine label the reference carries, then the catalog, then the id', async () => {
    const helper: AgentReference = { refId: `ar:${MESSAGE_ID}:helper`, profile: 'helper', executor: 'claude-code', configuration: 'profile', label: 'helper', engine_label: 'Claude Code' };
    const scout: AgentReference = { refId: `ar:${MESSAGE_ID}:scout`, profile: 'scout', executor: 'codex', configuration: 'profile', label: 'scout' };
    const catalog = [{ id: 'claude-code', label: 'Claude Code (catalog)' }, { id: 'codex', label: 'Codex' }];
    const labeled = await render('ask kiki://agents/helper and kiki://agents/scout', { references: [helper, scout], executors: catalog });
    const helperChip = labeled.querySelector<HTMLElement>(`[data-agent-ref-chip="${helper.refId}"]`)!;
    // The reference's own persisted label wins over the catalog.
    expect(helperChip.textContent).toContain('Claude Code');
    expect(helperChip.textContent).not.toContain('Claude Code (catalog)');
    expect(helperChip.textContent).not.toContain('claude-code');
    // An older record has no engine_label, so the catalog's label is read.
    const scoutChip = labeled.querySelector<HTMLElement>(`[data-agent-ref-chip="${scout.refId}"]`)!;
    expect(scoutChip.textContent).toContain('Codex');
    expect(scoutChip.textContent).not.toContain('codex');
    // With neither a persisted label nor a catalog entry, the raw id is read.
    const fallback = await render('ask kiki://agents/scout', { references: [scout] });
    const fallbackChip = fallback.querySelector<HTMLElement>(`[data-agent-ref-chip="${scout.refId}"]`)!;
    expect(fallbackChip.textContent).toContain('codex');
  });

  it('jumps to the most recent run when one reference ran several children', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const older = task({ id: 'task-older', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-older', description: 'First sweep', status: 'completed', started_at: '2026-01-01T10:00:00.000Z' });
    const newer = task({ id: 'task-newer', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-newer', description: 'Second sweep', status: 'completed', started_at: '2026-01-01T12:00:00.000Z' });
    const container = await render('use kiki://agents/worker', { references: [ref], tasks: [older, newer], onOpenAgent });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    expect(chip.getAttribute('data-agent-ref-runs')).toBe('2');
    expect(chip.textContent).toContain('2 runs');
    // The click opens the run menu rather than jumping blind; the most recent
    // run is the first item and is marked, and picking a run opens that child.
    await act(async () => { chip.click(); });
    const menu = document.querySelector<HTMLElement>('[data-agent-ref-runs-menu]')!;
    expect(menu).not.toBeNull();
    const items = [...menu.querySelectorAll<HTMLElement>('[data-menu-item]')];
    expect(items).toHaveLength(2);
    // The reader tells the runs apart without a task id: "Most recent" leads,
    // then the run's own label and status; the older run keeps its label.
    expect(items[0]!.textContent).toContain('Most recent');
    expect(items[0]!.textContent).toContain('Second sweep');
    expect(items[0]!.textContent).toContain('Completed');
    expect(items[1]!.textContent).toContain('First sweep');
    expect(items[0]!.textContent).not.toContain('task-newer');
    await act(async () => { items[0]!.click(); });
    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith('agent-newer');
  });

  it('opens an earlier run from the menu when one is picked', async () => {
    const onOpenAgent = vi.fn();
    const ref = reference('worker');
    const older = task({ id: 'task-older', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-older', description: 'First sweep', status: 'completed', started_at: '2026-01-01T10:00:00.000Z' });
    const newer = task({ id: 'task-newer', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-newer', description: 'Second sweep', status: 'completed', started_at: '2026-01-01T12:00:00.000Z' });
    const container = await render('use kiki://agents/worker', { references: [ref], tasks: [older, newer], onOpenAgent });
    const chip = container.querySelector<HTMLElement>(`[data-agent-ref-chip="${ref.refId}"]`)!;
    await act(async () => { chip.click(); });
    const items = [...document.querySelectorAll<HTMLElement>('[data-agent-ref-runs-menu] [data-menu-item]')];
    await act(async () => { items[1]!.click(); });
    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith('agent-older');
  });
});
