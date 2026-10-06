// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { QueueHeaderSummary, QueueStrip } from './QueueStrip';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const ITEMS = [
  { promptId: 'p1', text: 'first parked prompt' },
  { promptId: 'p2', text: 'second parked prompt' },
  { promptId: 'p3', text: 'third parked prompt' },
] as const;

async function renderStrip(
  props: Partial<Parameters<typeof QueueStrip>[0]> = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <QueueStrip
          items={ITEMS}
          onSendNow={() => {}}
          onRemove={() => {}}
          onClearAll={() => {}}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return { container, root };
}

/** Rows minus the aria-hidden drop-slot indicator lines. */
function rows(container: HTMLDivElement): HTMLLIElement[] {
  return Array.from(container.querySelectorAll<HTMLLIElement>('ol > li:not([aria-hidden])'));
}

function handleOf(container: HTMLDivElement, index: number): HTMLButtonElement {
  const handle = rows(container)[index]?.querySelector<HTMLButtonElement>(
    'button[aria-label="Reorder this queued prompt"]',
  );
  if (handle === null || handle === undefined) throw new Error(`no drag handle on row ${index}`);
  return handle;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Controlled-select change: the native setter bypasses React's value tracker. */
async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no native select value setter');
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function keydown(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** These unit events check geometry/contracts, not actual desktop mouse delivery. */
async function pointer(target: Element, type: string, clientY: number, clientX = 20, pointerId = 1): Promise<void> {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  });
}

function queueGeometry(container: HTMLDivElement): void {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(container.querySelector('ol')!, 'getBoundingClientRect').mockReturnValue(box(100, rows(container).length * 40));
  rows(container).forEach((row, index) => {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(box(100 + index * 40, 40));
    const handle = row.querySelector<HTMLButtonElement>('button[aria-label="Reorder this queued prompt"]');
    if (handle !== null) {
      handle.setPointerCapture = vi.fn();
      handle.hasPointerCapture = vi.fn(() => true);
      handle.releasePointerCapture = vi.fn();
    }
  });
}

describe('QueueStrip remove confirmation', () => {
  it('arms Remove on the first click and removes on the second', async () => {
    const onRemove = vi.fn();
    const { container } = await renderStrip({ onRemove });
    const row = rows(container)[0]!;

    await click(row.querySelector('button[aria-label="Remove"]')!);
    expect(onRemove).not.toHaveBeenCalled();
    const armed = row.querySelector('button[aria-label="Remove?"]');
    expect(armed).not.toBeNull();

    await click(armed!);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('disarms an armed Remove after the timeout without removing', async () => {
    vi.useFakeTimers();
    try {
      const onRemove = vi.fn();
      const { container } = await renderStrip({ onRemove });
      const row = rows(container)[1]!;

      await click(row.querySelector('button[aria-label="Remove"]')!);
      expect(row.querySelector('button[aria-label="Remove?"]')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(row.querySelector('button[aria-label="Remove?"]')).toBeNull();
      expect(row.querySelector('button[aria-label="Remove"]')).not.toBeNull();
      expect(onRemove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms an armed Remove with Escape', async () => {
    const onRemove = vi.fn();
    const { container } = await renderStrip({ onRemove });
    const row = rows(container)[0]!;

    await click(row.querySelector('button[aria-label="Remove"]')!);
    await keydown(row.querySelector('button[aria-label="Remove?"]')!, 'Escape');
    expect(row.querySelector('button[aria-label="Remove"]')).not.toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe('QueueStrip edit round-trip', () => {
  it('starts the composer edit via onEdit with the row prompt id', async () => {
    const onEdit = vi.fn();
    const { container } = await renderStrip({ items: [ITEMS[0]], onEdit });

    await click(container.querySelector('button[aria-label="Edit queued prompt"]')!);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('shows queued images, permits editing attachment-only prompts and removes visible attachments', async () => {
    const onEdit = vi.fn();
    const onRemoveAttachment = vi.fn();
    const { container } = await renderStrip({
      items: [{
        promptId: 'p-media', text: '',
        media: [
          { kind: 'image', url: 'https://example.test/first.png', name: 'first.png' },
          { kind: 'image', url: 'https://example.test/second.png', name: 'second.png' },
        ],
        content: [
          { type: 'image', source: { kind: 'url', url: 'https://example.test/first.png' } },
          { type: 'image', source: { kind: 'url', url: 'https://example.test/second.png' } },
        ],
      }],
      onEdit,
      onRemoveAttachment,
    });
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(container.textContent).toContain('first.png');
    expect(container.textContent).toContain('second.png');
    await click(container.querySelector('button[aria-label="Edit queued prompt"]')!);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('p-media');
    await click(container.querySelector('button[aria-label="Remove first.png"]')!);
    expect(onRemoveAttachment).toHaveBeenCalledExactlyOnceWith('p-media', 0);
  });

  it('keeps the last attachment of an attachment-only prompt until its text is edited or the row is removed', async () => {
    const { container } = await renderStrip({
      items: [{
        promptId: 'p-only', text: '', media: [{ kind: 'image', name: 'only.png' }],
        content: [{ type: 'image', source: { kind: 'url', url: 'https://example.test/only.png' } }],
      }],
      onRemoveAttachment: vi.fn(),
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Remove only.png"]')?.disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Remove"]')).not.toBeNull();
  });

  it('marks the row being edited, locks the other rows, and says the queue waits for it', async () => {
    const { container } = await renderStrip({ onEdit: vi.fn(), editingPromptId: 'p2' });
    const list = rows(container);

    // The edited row swaps its action group for its own start condition.
    expect(list[1]!.querySelector('[data-queue-edit-status]')?.textContent).toBe('Editing · starts after this turn');
    expect(list[1]!.querySelector('button[aria-label="Edit queued prompt"]')).toBeNull();
    expect(list[1]!.querySelector('button[aria-label="Remove"]')).toBeNull();
    // Other rows keep their actions but Edit is disabled for the duration.
    expect(
      list[0]!.querySelector<HTMLButtonElement>('button[aria-label="Edit queued prompt"]')!.disabled,
    ).toBe(true);
    // Ahead of the edit: sends as usual. Behind it: waits, and says so.
    expect(list[0]!.hasAttribute('data-queue-waits-edit')).toBe(false);
    expect(list[0]!.querySelector('[data-queue-waits-hint]')).toBeNull();
    expect(list[2]!.hasAttribute('data-queue-waits-edit')).toBe(true);
    expect(list[2]!.querySelector('[data-queue-waits-hint]')?.textContent).toBe('waits for your edit');
    const notice = container.querySelector('[data-queue-hold-notice]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('the 1 ahead still send');
    expect(container.querySelector('[data-queue-strip]')!.getAttribute('aria-describedby')).toBe(notice?.id);
  });

  it('says an edited prompt is ready when its start condition is already met', async () => {
    const { container } = await renderStrip({
      items: [{ promptId: 'p1', text: 'after the subagents', appendTiming: 'subagents_done' }],
      onEdit: vi.fn(),
      editingPromptId: 'p1',
      timingReady: (timing) => timing === 'subagents_done',
    });
    expect(container.querySelector('[data-queue-edit-status]')?.textContent).toBe('Ready · sends when you finish editing');
    // Editing the head: nothing ahead, the plain notice.
    expect(container.querySelector('[data-queue-hold-notice]')?.textContent).toContain('the queue resumes in order');
  });

  it('shows no hold notice while nothing is being edited', async () => {
    const { container } = await renderStrip();
    expect(container.querySelector('[data-queue-hold-notice]')).toBeNull();
    expect(container.querySelector('[data-queue-waits-hint]')).toBeNull();
  });
});

describe('QueueStrip scheduled delivery modes', () => {
  const cron = (promptId: string, cronDeliveryMode: 'queue' | 'steer' | 'idle' | undefined, text = 'Controller self-check.') => ({
    promptId,
    text,
    originKind: 'cron_job' as const,
    cronDeliveryMode,
    content: [{ type: 'text' as const, text }],
    media: [],
  });

  it('keeps a queue-mode job an ordinary queued message, controls and all', async () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const onMove = vi.fn();
    const onChangeTiming = vi.fn();
    const { container } = await renderStrip({
      items: [cron('q1', 'queue'), { promptId: 'user-1', text: 'my own message' }],
      onEdit, onSendNow, onMove, onChangeTiming,
    });
    const row = rows(container)[0]!;
    // In the user's send order, so nothing is withheld: the row is not marked
    // held and it carries the same controls as the message beside it.
    expect(row.getAttribute('data-queue-held')).toBeNull();
    expect(row.querySelector('button[aria-label="Reorder this queued prompt"]')).not.toBeNull();
    expect(row.querySelector('select[data-timing-picker]')).not.toBeNull();
    const sendNow = row.querySelector<HTMLButtonElement>('button[aria-label="Send now"]')!;
    expect(sendNow.disabled).toBe(false);
    await click(sendNow);
    expect(onSendNow).toHaveBeenCalledWith('q1');
  });

  it('treats a legacy scheduled record with no mode as the FIFO it still is', async () => {
    const { container } = await renderStrip({
      items: [cron('legacy', undefined), { promptId: 'user-1', text: 'my own message' }],
      onMove: vi.fn(),
      onChangeTiming: vi.fn(),
    });
    const row = rows(container)[0]!;
    expect(row.getAttribute('data-queue-held')).toBeNull();
    expect(row.querySelector('button[aria-label="Reorder this queued prompt"]')).not.toBeNull();
    expect(row.querySelector('select[data-timing-picker]')).not.toBeNull();
  });

  it.each(['idle', 'steer'] as const)('keeps a %s job readable and removable but out of the send order', async (mode) => {
    const onSendNow = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const { container } = await renderStrip({
      items: [cron('held-1', mode, 'Read the runbook before the next release.'), { promptId: 'user-1', text: 'my own message' }],
      onSendNow, onEdit, onRemove, onMove: vi.fn(), onChangeTiming: vi.fn(),
    });
    const row = rows(container)[0]!;
    expect(row.getAttribute('data-queue-held')).toBe(mode);
    // It names the timing that holds it instead of pretending to be pending.
    // The mode chip carries only the mode — the row's badge beside it already
    // says "scheduled", so repeating the word would stutter.
    expect(row.querySelector('[data-queue-held-mode]')?.textContent).toBe(
      mode === 'idle' ? 'Insert when idle' : 'Insert immediately',
    );
    expect(row.textContent).toContain('Read the runbook before the next release.');
    // The controls that would re-order or rush it are absent, not greyed out:
    // a dead Send now beside a live one reads as a broken row, and a note
    // saying the row is read-only costs the preview the width it needs.
    expect(row.querySelector('button[aria-label="Reorder this queued prompt"]')).toBeNull();
    expect(row.querySelector('select[data-timing-picker]')).toBeNull();
    expect(row.querySelector('button[aria-label="Send now"]')).toBeNull();
    expect(row.querySelector('[data-queue-read-only]')).toBeNull();
    // Remove stays: the record is real work, and withdrawing it is a real
    // action. Two-step like any other row: arm, then remove.
    const disclosure = row.querySelector('details')!;
    expect(disclosure.querySelector('p')?.textContent).toBe('Read the runbook before the next release.');
    await click(rows(container)[0]!.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!);
    await click(rows(container)[0]!.querySelector<HTMLButtonElement>('button[aria-label="Remove?"]')!);
    expect(onRemove).toHaveBeenCalledWith('held-1');
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it('gives a held job the same shape whether or not user messages are queued', async () => {
    // Held alone, the row must not acquire controls just because there is
    // nothing beside it to compare against.
    const { container } = await renderStrip({
      items: [cron('held-1', 'idle')],
      onEdit: vi.fn(),
      onMove: vi.fn(),
      onChangeTiming: vi.fn(),
    });
    const row = rows(container)[0]!;
    expect(row.getAttribute('data-queue-held')).toBe('idle');
    expect(row.querySelector('button[aria-label="Send now"]')).toBeNull();
    expect(row.querySelector('button[aria-label="Reorder this queued prompt"]')).toBeNull();
    expect(row.querySelector('select[data-timing-picker]')).toBeNull();
    expect(row.querySelector('button[aria-label="Remove"]')).not.toBeNull();
  });

  it('keeps user messages and attachment-only rows out of the mode rule entirely', async () => {
    const { container } = await renderStrip({
      items: [
        { promptId: 'user-1', text: 'my own message' },
        { promptId: 'user-2', text: '', media: [{ kind: 'image', url: 'https://example.test/a.png' }] as never },
        cron('held-1', 'idle'),
      ],
      onMove: vi.fn(),
      onChangeTiming: vi.fn(),
    });
    const [first, second, third] = rows(container);
    expect(first!.getAttribute('data-queue-held')).toBeNull();
    expect(second!.getAttribute('data-queue-held')).toBeNull();
    expect(first!.querySelector('select[data-timing-picker]')).not.toBeNull();
    expect(second!.querySelector('select[data-timing-picker]')).not.toBeNull();
    expect(third!.getAttribute('data-queue-held')).toBe('idle');
  });

  async function renderSummary(count: number, heldCount: number): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <QueueHeaderSummary count={count} heldCount={heldCount} />
        </I18nProvider>,
      );
    });
    return container;
  }

  it('names held scheduled jobs beside the ordinary count instead of counting them as queued', async () => {
    const container = await renderSummary(2, 1);
    expect(container.querySelector('[data-queue-count]')?.textContent).toBe('2 queued');
    // Neutral about when they go: the count says they are waiting, and each
    // row says its own timing. "Earlier" would claim an order the modes do
    // not share.
    expect(container.querySelector('[data-queue-held-count]')?.textContent).toContain('1 scheduled waiting');
  });

  it('shows only the scheduled jobs when nothing of your own is queued', async () => {
    const container = await renderSummary(0, 2);
    // "0 queued" beside real work reads as nothing to send.
    expect(container.querySelector('[data-queue-count]')).toBeNull();
    expect(container.querySelector('[data-queue-held-count]')?.textContent).toBe('2 scheduled waiting');
  });

  it('shows the ordinary count alone when nothing scheduled is held', async () => {
    const container = await renderSummary(3, 0);
    expect(container.querySelector('[data-queue-count]')?.textContent).toBe('3 queued');
    expect(container.querySelector('[data-queue-held-count]')).toBeNull();
  });
});

describe('QueueStrip drawer body', () => {
  it('identifies scheduled text and discloses its body without making it an editable attachment row', async () => {
    const text = 'Controller self-check: keep existing work running.';
    const { container } = await renderStrip({ items: [{ promptId: 'scheduled-1', originKind: 'cron_job', text, content: [{ type: 'text', text }], media: [] }], onEdit: vi.fn() });
    const row = rows(container)[0]!;
    expect(row.textContent).toContain('Scheduled job');
    expect(row.textContent).not.toContain('(attachment only)');
    const disclosure = row.querySelector('details')!;
    expect(disclosure.querySelector('p')?.textContent).toBe(text);
    await click(disclosure.querySelector('summary')!);
    expect(disclosure.open).toBe(true);
    expect(row.querySelector('button[aria-label="Edit queued prompt"]')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
  });

  it('lists every row with Clear all in the header (the tab carries the count)', async () => {
    const onClearAll = vi.fn();
    const { container } = await renderStrip({ onClearAll });
    expect(rows(container)).toHaveLength(3);
    expect(container.querySelector('ol')!.hasAttribute('hidden')).toBe(false);
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Clear all')!);
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('summarises the queue for the composer row: just the count and the chevron', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <QueueHeaderSummary count={2} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector('[data-queue-count]')?.textContent).toBe('2 queued');
  });
});

describe('QueueStrip reorder', () => {
  it('hides the drag handle for a single queued prompt', async () => {
    const { container } = await renderStrip({ items: [ITEMS[0]], onMove: vi.fn() });
    expect(container.querySelector('button[aria-label="Reorder this queued prompt"]')).toBeNull();
  });

  it('hides the drag handle until the parent wires onMove', async () => {
    const { container } = await renderStrip();
    expect(container.querySelector('button[aria-label="Reorder this queued prompt"]')).toBeNull();
  });

  it('moves a row with the handle keyboard controls and stops at the edges', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });

    await keydown(handleOf(container, 0), 'ArrowDown');
    expect(onMove).toHaveBeenLastCalledWith('p1', 1);
    await keydown(handleOf(container, 2), 'ArrowUp');
    expect(onMove).toHaveBeenLastCalledWith('p3', 1);

    const calls = onMove.mock.calls.length;
    await keydown(handleOf(container, 0), 'ArrowUp');
    await keydown(handleOf(container, 2), 'ArrowDown');
    expect(onMove).toHaveBeenCalledTimes(calls);
  });

  it('captures the pointer and converts a drop below a later row into the post-removal index', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    const handle = handleOf(container, 0);
    expect(handle.draggable).toBe(false);
    await pointer(handle, 'pointerdown', 110);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    await pointer(handle, 'pointermove', 210);
    expect(container.querySelector('li[aria-hidden]')).not.toBeNull();
    await pointer(handle, 'pointerup', 210);
    // Slot 3 after lifting #1 out → 2. A trailing capture loss is not another move.
    await pointer(handle, 'lostpointercapture', 210);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('p1', 2);
    expect(container.querySelector('li[aria-hidden]')).toBeNull();
  });

  it('uses the release position above an earlier row, not a stale hover slot', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    const handle = handleOf(container, 2);
    await pointer(handle, 'pointerdown', 210);
    await pointer(handle, 'pointermove', 170);
    await pointer(handle, 'pointerup', 110);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('p3', 0);
  });

  it('ignores a click, small jitter and a drop back onto the same slot', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    const handle = handleOf(container, 1);
    await pointer(handle, 'pointerdown', 150);
    await pointer(handle, 'pointermove', 152);
    await pointer(handle, 'pointerup', 152);
    await pointer(handle, 'pointerdown', 150);
    await pointer(handle, 'pointermove', 169);
    await pointer(handle, 'pointerup', 169);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('cancels on Escape, pointer cancellation, capture loss or release outside the queue', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    const handle = handleOf(container, 0);
    for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape', 'outside']) {
      await pointer(handle, 'pointerdown', 110);
      await pointer(handle, 'pointermove', 210);
      if (cancel === 'Escape') await keydown(handle, 'Escape');
      else if (cancel !== 'outside') await pointer(handle, cancel, 210);
      await pointer(handle, 'pointerup', 210, cancel === 'outside' ? 400 : 20);
      expect(container.querySelector('li[aria-hidden]')).toBeNull();
    }
    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not drop onto a row clipped outside the composer queue viewport', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    container.classList.add('composer-header-scroll');
    const rect = container.querySelector('ol')!.getBoundingClientRect();
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(rect.x, rect.y, rect.width, 80));
    const handle = handleOf(container, 0);
    await pointer(handle, 'pointerdown', 110);
    await pointer(handle, 'pointermove', 210);
    await pointer(handle, 'pointerup', 210);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores another pointer and leaves the edited prompt unmovable', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({ onMove, editingPromptId: 'p2' });
    queueGeometry(container);
    expect(handleOf(container, 1).disabled).toBe(true);
    const handle = handleOf(container, 0);
    await pointer(handle, 'pointerdown', 110);
    await pointer(handle, 'pointermove', 210, 20, 2);
    await pointer(handle, 'pointerup', 210, 20, 2);
    expect(onMove).not.toHaveBeenCalled();
    await pointer(handle, 'pointerup', 110);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('locks reordering while a move is in flight', async () => {
    const gate = deferred<void>();
    const onMove = vi.fn(() => gate.promise);
    const { container } = await renderStrip({ onMove });

    await keydown(handleOf(container, 0), 'ArrowDown');
    expect(onMove).toHaveBeenCalledExactlyOnceWith('p1', 1);
    expect(handleOf(container, 0).disabled).toBe(true);
    expect(handleOf(container, 1).disabled).toBe(true);
    expect(handleOf(container, 2).disabled).toBe(true);

    // A second move computed against the pre-move order would land on a stale
    // slot, so the latch swallows it.
    await keydown(handleOf(container, 2), 'ArrowUp');
    expect(onMove).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
    });
    expect(handleOf(container, 0).disabled).toBe(false);
  });

  it('keeps authoritative rows and unlocks after the parent handles a failed move', async () => {
    const reportError = vi.fn();
    const onMove = vi.fn(() => Promise.reject(new Error('move unavailable')).catch(reportError));
    const { container } = await renderStrip({ onMove });
    queueGeometry(container);
    const handle = handleOf(container, 0);
    await pointer(handle, 'pointerdown', 110);
    await pointer(handle, 'pointermove', 210);
    await pointer(handle, 'pointerup', 210);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('p1', 2);
    expect(reportError).toHaveBeenCalledOnce();
    expect(rows(container).map(row => row.dataset['queueItem'])).toEqual(['p1', 'p2', 'p3']);
    expect(handle.disabled).toBe(false);
    expect(container.querySelector('li[aria-hidden]')).toBeNull();
  });
});

describe('QueueStrip timing picker', () => {
  it('shows the row timing selected, defaults to agent_idle when absent, and rides the hover action set', async () => {
    const { container } = await renderStrip({
      items: [
        { promptId: 'p1', text: 'one', appendTiming: 'subagents_done', revision: 3 },
        { promptId: 'p2', text: 'two' },
      ],
      onChangeTiming: () => {},
    });
    const first = container.querySelector<HTMLSelectElement>('[data-timing-picker="p1"]')!;
    expect(first.tagName).toBe('SELECT');
    expect(first.value).toBe('subagents_done');
    expect(first.querySelector('[data-timing="subagents_done"]')?.textContent).toBe('after subagents');
    // The dropdown lives in the hover/focus-revealed action set like the
    // edit / send-now / remove buttons.
    expect(first.closest('.dock-reveal[data-queue-row-actions]')).not.toBeNull();
    // Older servers omit the field; the display falls back to agent_idle.
    const second = container.querySelector<HTMLSelectElement>('[data-timing-picker="p2"]')!;
    expect(second.value).toBe('agent_idle');
    expect(second.querySelector('[data-timing="agent_idle"]')?.textContent).toBe('after this turn');
  });

  it('calls onChangeTiming with the picked timing and ignores the current one', async () => {
    const onChangeTiming = vi.fn();
    const { container } = await renderStrip({
      items: [{ promptId: 'p1', text: 'one', appendTiming: 'agent_idle' }],
      onChangeTiming,
    });
    const picker = container.querySelector<HTMLSelectElement>('[data-timing-picker="p1"]')!;
    await changeSelect(picker, 'tasks_done');
    expect(onChangeTiming).toHaveBeenCalledExactlyOnceWith('p1', 'tasks_done');
    await changeSelect(picker, 'agent_idle');
    expect(onChangeTiming).toHaveBeenCalledTimes(1);
  });

  it('hides the picker until the parent wires onChangeTiming', async () => {
    const { container } = await renderStrip();
    expect(container.querySelector('[data-timing-picker]')).toBeNull();
  });

  it('disables the picker while a row action is in flight', async () => {
    const gate = deferred<void>();
    const onChangeTiming = vi.fn(() => gate.promise);
    const { container } = await renderStrip({
      items: [{ promptId: 'p1', text: 'one' }],
      onChangeTiming,
    });
    const picker = container.querySelector<HTMLSelectElement>('[data-timing-picker="p1"]')!;
    await changeSelect(picker, 'tasks_done');
    expect(onChangeTiming).toHaveBeenCalledExactlyOnceWith('p1', 'tasks_done');
    expect(picker.disabled).toBe(true);
    await act(async () => {
      gate.resolve();
    });
    expect(picker.disabled).toBe(false);
  });
});

describe('QueueStrip model-switch control rows', () => {
  const switchEntry = (overrides: {
    operationId?: string;
    state?: 'pending' | 'preparing' | 'completed' | 'failed' | 'cancelled';
    mode?: 'direct' | 'compact' | 'fresh';
    queueIndex?: number;
    toModel?: string;
  } = {}) => {
    const operationId = overrides.operationId ?? 'op-1';
    const mode = overrides.mode ?? 'fresh';
    const state = overrides.state ?? 'pending';
    const toModel = overrides.toModel ?? 'example/new';
    return {
      input: { operationId, model: toModel, mode, selectedFromModel: 'example/old' },
      receipt: {
        operationId,
        agentId: 'main',
        state,
        fromModel: 'example/old',
        toModel,
        mode,
      },
      revision: 1,
      originalBinding: { model: 'example/old', thinking: 'high' },
      queueIndex: overrides.queueIndex ?? 0,
    };
  };

  it('renders a queued switch in drain order with its mode, and cancels by operation id', async () => {
    const onCancelModelSwitch = vi.fn();
    const { container } = await renderStrip({
      items: [{ promptId: 'p1', text: 'first parked prompt', queuePosition: 1 }],
      modelSwitches: [switchEntry({ queueIndex: 0 })],
      onCancelModelSwitch,
      onEditModelSwitch: () => {},
    });
    const rowTexts = rows(container).map((row) => row.textContent ?? '');
    expect(rowTexts[0]).toContain('Will switch to example/new when idle');
    expect(rowTexts[0]).toContain('Fresh context');
    expect(rowTexts[1]).toContain('first parked prompt');
    const cancel = container.querySelector<HTMLButtonElement>('[data-queue-model-switch-actions] button:last-child')!;
    await click(cancel);
    expect(onCancelModelSwitch).toHaveBeenCalledExactlyOnceWith('op-1');
  });

  it('counts the switch slot when dragging a message across it without making the control row draggable', async () => {
    const onMove = vi.fn();
    const { container } = await renderStrip({
      items: [{ ...ITEMS[0], queuePosition: 0 }, { ...ITEMS[1], queuePosition: 2 }],
      modelSwitches: [switchEntry({ queueIndex: 1 })],
      onMove,
    });
    queueGeometry(container);
    expect(rows(container)[1]!.querySelector('button[aria-label="Reorder this queued prompt"]')).toBeNull();
    const handle = handleOf(container, 2);
    await pointer(handle, 'pointerdown', 210);
    await pointer(handle, 'pointermove', 150);
    await pointer(handle, 'pointerup', 150);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('p2', 1);
    expect(container.querySelector('[data-queue-model-switch="op-1"]')).not.toBeNull();
  });

  it('names the progress of a preparing switch and offers no cancel for it', async () => {
    const { container } = await renderStrip({
      items: [],
      modelSwitches: [switchEntry({ state: 'preparing', mode: 'compact' })],
      onCancelModelSwitch: () => {},
      onEditModelSwitch: () => {},
    });
    expect(container.textContent).toContain('example/old is summarizing the conversation…');
    expect(container.querySelector('[data-queue-model-switch-actions]')).toBeNull();
    expect(container.querySelector('[data-queue-strip]')).not.toBeNull();
  });

  it('leaves a launched switch out of the strip', async () => {
    const { container } = await renderStrip({
      items: [],
      modelSwitches: [switchEntry({ state: 'completed', queueIndex: -1 })],
      onCancelModelSwitch: () => {},
    });
    expect(container.querySelector('[data-queue-strip]')).toBeNull();
  });
});

describe('QueueStrip pending switch labels', () => {
  it('shows the same canonical reasoning target as the composer without calling it a model switch', async () => {
    const { container } = await renderStrip({ items: [], resolveModelId: value => value === 'model' ? 'example/model' : value,
      modelSwitches: [{ input: { operationId: 'reasoning-choice', model: 'model', thinking: 'max', mode: 'direct' },
        receipt: { operationId: 'reasoning-choice', agentId: 'main', state: 'pending', fromModel: 'example/model', toModel: 'model', mode: 'direct' },
        originalBinding: { model: 'example/model', thinking: 'high' }, revision: 0, queueIndex: 0 }],
    });
    const row = container.querySelector('[data-queue-model-switch]')!;
    expect(row.textContent).toContain('Reasoning change → max');
    expect(row.textContent).not.toContain('Switching to');
  });
});
