import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/protocol';

import { I18nProvider } from '../i18n';
import { ContextMeter } from './ContextMeter';
import { PendingBadge } from './PendingBadge';
import { QueueStrip } from './QueueStrip';
import {
  NOT_FOUND_FALLBACK_MS,
  resolveAllApprovals,
  resolveControlledFlag,
  resolveControlledValue,
  SessionRouteView,
  shouldClearModeOverride,
  TerminalToggle,
} from './SessionView';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

function renderTerminalToggle(available: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TerminalToggle available={available} open={false} onToggle={() => {}} />
    </I18nProvider>,
  );
}

describe('SessionView terminal capability', () => {
  it('omits the terminal toggle when the server omits terminal capability', () => {
    expect(renderTerminalToggle(false)).not.toContain('data-terminal-toggle');
  });

  it('renders the terminal toggle when the server advertises terminal capability', () => {
    expect(renderTerminalToggle(true)).toContain('data-terminal-toggle');
  });
});

describe('QueueStrip', () => {
  const noop = () => {};
  // Copy assertions are English: pin the locale source (Node's built-in
  // navigator reports the OS language) for this describe only.
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders one row per queued prompt with drain-order numbers and actions', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[
            { promptId: 'p1', text: 'first parked prompt' },
            { promptId: 'p2', text: 'second parked prompt' },
          ]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-queue-strip');
    expect(html).toContain('2 prompts queued');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('first parked prompt');
    expect(html).toContain('second parked prompt');
    expect(html).toContain('Send now');
    expect(html).toContain('Remove');
    expect(html).toContain('Clear all');
  });

  it('renders nothing for an empty queue', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip items={[]} onSendNow={noop} onRemove={noop} onClearAll={noop} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });
});

describe('SessionView route ownership', () => {
  it('changes the child owner key synchronously on session A to B navigation', () => {
    const props = { onToggleSidebar: () => {}, sessions: [] };
    const sessionA = SessionRouteView({ ...props, sessionId: 'session-a' });
    const sessionB = SessionRouteView({ ...props, sessionId: 'session-b' });

    expect(sessionA.key).toBe('session-a');
    expect(sessionB.key).toBe('session-b');
    expect(sessionB.key).not.toBe(sessionA.key);
  });
});

describe('store-controlled mode pills', () => {
  it('prefers the local optimistic echo, then the store value, then the default', () => {
    expect(resolveControlledValue('yolo', 'manual', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, 'yolo', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, undefined, 'auto')).toBe('auto');
  });

  it('keeps the configured default until the snapshot lands for flag pills', () => {
    // Before load the store holds zero-value defaults — the client default wins.
    expect(resolveControlledFlag(undefined, false, false, true)).toBe(true);
    // After load the server-reported value is authoritative.
    expect(resolveControlledFlag(undefined, false, true, true)).toBe(false);
    // A local click always wins over both.
    expect(resolveControlledFlag(true, false, true, false)).toBe(true);
  });

  it('retires the optimistic echo only when the store reports the same value', () => {
    expect(shouldClearModeOverride('auto', 'auto')).toBe(true);
    expect(shouldClearModeOverride('auto', 'manual')).toBe(false);
    expect(shouldClearModeOverride('auto', undefined)).toBe(false);
    expect(shouldClearModeOverride(undefined, 'auto')).toBe(false);
  });
});

describe('resolveAllApprovals', () => {
  it('resolves every pending id and reports failures without rejecting', async () => {
    const calls: Array<[string, string]> = [];
    const controller = {
      resolveApproval: (id: string, decision: 'approved' | 'rejected') => {
        calls.push([id, decision]);
        return id === 'a2' ? Promise.reject(new Error('expired')) : Promise.resolve();
      },
    };
    const result = await resolveAllApprovals(controller, ['a1', 'a2', 'a3'], 'approved');
    expect(calls).toEqual([
      ['a1', 'approved'],
      ['a2', 'approved'],
      ['a3', 'approved'],
    ]);
    expect(result).toEqual({ total: 3, failed: 1 });
  });

  it('reports zero failures when every decision lands', async () => {
    const controller = { resolveApproval: () => Promise.resolve() };
    await expect(resolveAllApprovals(controller, ['a1'], 'rejected')).resolves.toEqual({
      total: 1,
      failed: 0,
    });
  });
});

describe('ContextMeter', () => {
  const noop = () => {};
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function renderMeter(used: number, limit: number): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ContextMeter used={used} limit={limit} onCompact={noop} />
      </I18nProvider>,
    );
  }

  it('shows the rounded percentage without a compact hint below 80%', () => {
    const html = renderMeter(50_000, 100_000);
    expect(html).toContain('50%');
    expect(html).not.toContain('compact?');
    expect(html).not.toContain('amber-card');
  });

  it('turns amber and suggests compaction at exactly 80%', () => {
    const html = renderMeter(80_000, 100_000);
    expect(html).toContain('80%');
    expect(html).toContain('compact?');
    expect(html).toContain('amber-card');
  });

  it('clamps the display at 100% when usage overruns the limit', () => {
    const html = renderMeter(120_000, 100_000);
    expect(html).toContain('100%');
    expect(html).toContain('compact?');
  });
});

describe('session-not-found fallback', () => {
  it('waits three seconds before falling back home', () => {
    expect(NOT_FOUND_FALLBACK_MS).toBe(3000);
  });
});

describe('PendingBadge', () => {
  function sessionFixture(id: string, pending: Session['pending_interaction']): Session {
    return {
      id,
      workspace_id: 'wd_test',
      title: `Session ${id}`,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
      busy: false,
      pending_interaction: pending,
      archived: false,
      metadata: { cwd: 'C:/fixture' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    };
  }

  function renderBadge(sessions: readonly Session[]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <PendingBadge sessions={sessions} />
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when no session waits on the user', () => {
    expect(renderBadge([sessionFixture('s1', 'none')])).toBe('');
    expect(renderBadge([])).toBe('');
  });

  it('counts every session with a pending approval or question', () => {
    const html = renderBadge([
      sessionFixture('s1', 'approval'),
      sessionFixture('s2', 'question'),
      sessionFixture('s3', 'none'),
    ]);
    expect(html).toContain('data-pending-badge');
    expect(html).toContain('2 sessions waiting on you');
  });
});
