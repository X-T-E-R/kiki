// @vitest-environment jsdom

/**
 * Differential test for streaming markdown segmentation.
 *
 * AssistantMessage renders the settled streaming prefix as independently
 * memoized chunks (splitPrefixSegments) instead of one document, so a
 * paragraph-boundary delta re-parses only the newest chunk. That is only
 * legitimate if chunk-local parsing NEVER diverges from whole-document
 * parsing: this test renders both forms for every append prefix of a
 * simulated stream and requires the produced block-level DOM to be
 * byte-identical.
 *
 * The shiki code-engine loader is mocked out: highlighting is async and
 * would make the comparison timing-dependent; fence STRUCTURE still goes
 * through the production KikiCodeBlock chrome either way.
 *
 * Cases deliberately cover the constructs a naive blank-line splitter gets
 * wrong: >2KiB ``` and ~~~ fences containing blank lines, loose lists,
 * blockquote runs, and reference definitions (which force the single-
 * document fallback).
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { createViewState, type Block, type SessionViewState } from '../state/transcript';
import { Markdown } from './Markdown';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import {
  splitPrefixSegments,
  splitStreamingText,
  Transcript,
  TurnTailLine,
  type TranscriptRowActions,
} from './Transcript';

vi.mock('./markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  return { root, container };
}

/**
 * Render and wait for quiescence. Streamdown commits re-parsed blocks via
 * `startTransition` (streamdown/dist/chunk-*.js: `useEffect(() => {
 * U(() => setBlocks(fe)) })`), so immediately after a flushSync render the
 * DOM still shows the PREVIOUS content — and the transition commit itself
 * chains through further scheduled work (observed: several macrotasks).
 * `await act(...)` drains React's act queue recursively until everything —
 * transitions included — has landed, so both sides are compared settled.
 */
async function renderSettled(root: Root, node: ReactNode): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
}

/**
 * Serialize the block-level markdown content of every `.kiki-md` in the
 * container, joined in document order. Streamdown wraps its blocks in an
 * inner structural div (`space-y-4 …`); chunking legitimately produces one
 * such wrapper per chunk, so the comparison unwraps it and compares the
 * concatenation of the actual block trees. The plain-prose fast path has no
 * inner wrapper (a bare `<p>`), which is kept as-is.
 */
function blocksHtml(container: HTMLDivElement): string {
  return [...container.querySelectorAll('.kiki-md')]
    .map((element) => {
      const inner = element.firstElementChild;
      return inner instanceof HTMLDivElement && element.childElementCount === 1
        ? inner.innerHTML
        : element.innerHTML;
    })
    .join('');
}

/** Whole-document reference render. */
async function fullHtml(root: Root, container: HTMLDivElement, prefix: string): Promise<string> {
  await renderSettled(root, <Markdown text={prefix} />);
  return blocksHtml(container);
}

/** Chunked render, structured exactly like AssistantMessage. */
async function segmentedHtml(root: Root, container: HTMLDivElement, prefix: string): Promise<string> {
  const segments = splitPrefixSegments(prefix);
  await renderSettled(
    root,
    <div className="kiki-md-segments">
      {segments.map((segment, index) => (
        <Markdown key={index} text={segment} preserveEdgeMargins />
      ))}
    </div>,
  );
  return blocksHtml(container);
}

/** Deterministic irregular append sizes, so deltas cross boundaries at
 * many different offsets within tokens. */
const STEP_SIZES = [1, 3, 7, 2, 11, 5, 13, 4];

/**
 * Replay the stream append-by-append; at every step where the settled
 * prefix advanced, the chunked render must equal the whole-document render.
 *
 * Each comparison uses FRESH roots: what is being verified is the semantic
 * property "for any settled prefix, chunk-local parsing produces the same
 * block tree as whole-document parsing". Reusing roots across steps would
 * additionally race Streamdown's internal `startTransition` block commits
 * (which lag by several macrotasks and are briefly stale by design in
 * production too) — eventually consistent, but not step-wise comparable.
 */
async function expectStreamingEquivalence(fullText: string): Promise<void> {
  let cursor = 0;
  let step = 0;
  let previousPrefix = '';
  let comparisons = 0;
  while (cursor < fullText.length) {
    cursor = Math.min(fullText.length, cursor + STEP_SIZES[step % STEP_SIZES.length]!);
    step += 1;
    const { prefix } = splitStreamingText(fullText.slice(0, cursor));
    if (prefix === previousPrefix) continue;
    previousPrefix = prefix;
    const full = makeRoot();
    const segmented = makeRoot();
    const expected = await fullHtml(full.root, full.container, prefix);
    const actual = await segmentedHtml(segmented.root, segmented.container, prefix);
    comparisons += 1;
    expect(
      actual,
      `chunked render diverged at prefix length ${prefix.length}:\n--- prefix ---\n${prefix}\n--- whole-document ---\n${expected}`,
    ).toBe(expected);
  }
  expect(comparisons).toBeGreaterThan(0);
}

function repeatTo(unit: string, minLength: number): string {
  let text = '';
  while (text.length < minLength) text += unit;
  return text;
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(async () => {
  for (const root of roots) {
    await act(async () => {
      flushSync(() => {
        root.unmount();
      });
    });
  }
  for (const container of containers) container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

describe('splitPrefixSegments streaming differential', () => {
  it('keeps a >2KiB tilde fence with blank lines as one code block', { timeout: 60_000 }, async () => {
    const body = repeatTo('const answer = 42; // filler line inside the fence\n\n', 2600);
    const text = `Intro paragraph.\n\n~~~text\n${body}~~~\n\nClosing paragraph with **bold** text.`;
    // Guard the reviewer's reproduction directly: exactly one fence chrome.
    await expectStreamingEquivalence(text);
    const probe = makeRoot();
    await renderSettled(probe.root, <Markdown text={splitStreamingText(text).prefix} />);
    expect(probe.container.querySelectorAll('.kiki-cb')).toHaveLength(1);
  });

  it('keeps a >2KiB backtick fence with blank lines as one code block', { timeout: 60_000 }, async () => {
    const body = repeatTo('line of generated output that pads the fence\n\n', 2600);
    const text = `Before the fence.\n\n\`\`\`log\n${body}\`\`\`\n\nAfter the fence.`;
    await expectStreamingEquivalence(text);
    const probe = makeRoot();
    await renderSettled(probe.root, <Markdown text={splitStreamingText(text).prefix} />);
    expect(probe.container.querySelectorAll('.kiki-cb')).toHaveLength(1);
  });

  it('renders a >2KiB loose list identically across chunk boundaries', { timeout: 60_000 }, async () => {
    const items = repeatTo('- List item with enough prose to fill out the row nicely.\n\n', 2400);
    const text = `Lead-in.\n\n${items}Trailing paragraph.`;
    await expectStreamingEquivalence(text);
  });

  it('renders blockquote runs with blank lines identically', { timeout: 60_000 }, async () => {
    const quotes = repeatTo('> A quoted line that carries some prose weight.\n\n', 2400);
    const text = `Before the quotes.\n\n${quotes}After the quotes.`;
    await expectStreamingEquivalence(text);
  });

  it('falls back to single-document parsing when reference definitions exist', { timeout: 60_000 }, async () => {
    const text =
      'See [the first link][ref-a] early on.\n\n' +
      `${repeatTo('An intervening paragraph of prose.\n\n', 1200)}\n` +
      '[ref-a]: https://example.test/first\n' +
      '[ref-b]: https://example.test/second\n\n' +
      'Later text uses [the second link][ref-b] and a bare <https://example.test>.';
    // The fallback must actually engage for this fixture…
    expect(splitPrefixSegments(text)).toHaveLength(1);
    // …and the prefix built from every append step still matches the
    // whole-document render (trivially true in fallback, so this pins the
    // fallback itself against regressions).
    await expectStreamingEquivalence(text);
  });

  it('renders mixed prose (headings, lists, table, hr, inline code) identically', { timeout: 60_000 }, async () => {
    const section =
      '## Section heading\n\n' +
      'A paragraph with **bold**, *italic*, `inline code`, and a [link](https://example.test).\n\n' +
      '- tight item one\n- tight item two\n\n' +
      '| col a | col b |\n| --- | --- |\n| 1 | 2 |\n\n' +
      '---\n\n' +
      '> a short quote\n\n';
    const text = repeatTo(section, 2600);
    await expectStreamingEquivalence(text);
  });

  it('keeps app-page links in the current router while external links open separately', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <Markdown text={'[Usage](/usage) · [Docs](https://example.test/docs)'} />,
    );
    const usage = probe.container.querySelector<HTMLAnchorElement>('a[href="/usage"]');
    const docs = probe.container.querySelector<HTMLAnchorElement>('a[href="https://example.test/docs"]');
    expect(usage?.getAttribute('target')).toBeNull();
    expect(docs?.getAttribute('target')).toBe('_blank');
    expect(docs?.getAttribute('rel')).toContain('noopener');
  });

  it('chunks join back to the exact source and respect the size target', () => {
    const text = repeatTo('Paragraph number with prose.\n\n', 6000);
    const chunks = splitPrefixSegments(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeLessThanOrEqual(2200); // target + one block
    }
  });

  it('shows per-turn decode throughput in the turn tail', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <TurnTailLine
        tail={{
          turnId: '1',
          endedAt: new Date().toISOString(),
          durationMs: 4_200,
          ttftMs: 1_500,
          usage: {
            inputOther: 100,
            output: 30,
            inputCacheRead: 20,
            inputCacheCreation: 10,
          },
          tokensPerSecond: 19.6,
        }}
      />,
    );
    expect(probe.container.querySelector('[data-turn-tail]')?.textContent).toContain('20 tok/s');
  });
});

describe('media preview wiring', () => {
  it('renders message image refs as thumbnails that open the lightbox', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <MediaPartList
          media={[{ kind: 'image', url: 'data:image/png;base64,AA', mime: 'image/png' }]}
        />
      </MediaPreviewProvider>,
    );
    const thumb = probe.container.querySelector('img');
    expect(thumb?.getAttribute('src')).toBe('data:image/png;base64,AA');
    await act(async () => {
      thumb!.closest('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The lightbox portals to document.body.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
  });

  it('renders file refs as chips with name and size', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <MediaPartList
          media={[{ kind: 'file', fileId: 'upl_1', name: 'report.pdf', mime: 'application/pdf', size: 4096 }]}
        />
      </MediaPreviewProvider>,
    );
    expect(probe.container.textContent).toContain('report.pdf');
    expect(probe.container.textContent).toContain('4.0 KB');
  });

  it('opens the file preview pane from a workspace-relative markdown link', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'See [the config](./config/app.toml) for details.'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a');
    expect(link?.getAttribute('title')).toBe('/work/app/config/app.toml');
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The pane portals to document.body; without a connection the body shows
    // the failure notice, but the header still names the file.
    expect(document.body.textContent).toContain('app.toml');
    expect(document.body.textContent).toContain('/work/app/config/app.toml');
  });

  it('keeps app routes as router links even inside the preview provider', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'[Usage](/usage)'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/usage');
    expect(link?.getAttribute('title')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Message-closure row actions + collapsible user messages. These render the
// full Transcript; the ResizeObserver noop stub from beforeAll covers both
// use-stick-to-bottom and the collapse hook's observer path (the hook's
// synchronous first measure is what the collapse tests drive).

function transcriptState(blocks: Block[]): SessionViewState {
  return { ...createViewState('session_test'), loaded: true, blocks };
}

function noopActions(): Promise<void> {
  return Promise.resolve();
}

async function renderTranscript(
  blocks: Block[],
  rowActions?: TranscriptRowActions,
): Promise<HTMLDivElement> {
  const { root, container } = makeRoot();
  await renderSettled(
    root,
    <Transcript
      state={transcriptState(blocks)}
      onLoadOlder={() => Promise.resolve(false)}
      onResolveApproval={() => noopActions()}
      onAnswerQuestion={() => noopActions()}
      onDismissQuestion={() => noopActions()}
      rowActions={rowActions}
    />,
  );
  return container;
}

function userBlock(overrides: Partial<Extract<Block, { kind: 'user' }>> & { id: string; text: string }): Block {
  return { kind: 'user', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function assistantBlock(id: string, text: string): Block {
  return { kind: 'assistant', id, text, streaming: false, createdAt: '2026-01-01T00:00:01.000Z' };
}

function rowActionButtons(row: Element): string[] {
  return [...row.querySelectorAll('[data-row-action]')].map(
    (el) => el.getAttribute('data-row-action') ?? '',
  );
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('message row actions', () => {
  it('shows edit/fork on settled user rows and regenerate/fork on the latest final reply only', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-m1', text: 'first question', userMessageId: 'm1' }),
        assistantBlock('assistant-m2-0', 'first answer'),
        userBlock({ id: 'user-m3', text: 'second question', userMessageId: 'm3' }),
        assistantBlock('assistant-live-1-final-end@9', 'second answer'),
      ],
      rowActions,
    );
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rows).toHaveLength(4);
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'edit', 'fork']);
    // An older assistant row copies but never regenerates.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy']);
    expect(rowActionButtons(rows[2]!)).toEqual(['copy', 'edit', 'fork']);
    expect(rowActionButtons(rows[3]!)).toEqual(['copy', 'regenerate', 'fork']);
  });

  it('hides edit/fork on user rows without a wire identity or with a parked prompt', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'turn-1-prompt', text: 'placeholder without id' }),
        userBlock({ id: 'user-m9', text: 'parked', userMessageId: 'm9', promptStatus: 'queued' }),
      ],
      rowActions,
    );
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual(['copy']);
    expect(rowActionButtons(rows[1]!)).toEqual(['copy']);
  });

  it('hides all mutating actions when rowActions is absent (read-only surface)', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
      assistantBlock('assistant-m2-0', 'answer'),
    ]);
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual([]);
    // The assistant copy button survives without row actions.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy']);
  });

  it('edits inline: prefilled editor submits through onEditMessage', async () => {
    const onEditMessage = vi.fn();
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-m1', text: 'original text', userMessageId: 'm1' })],
      rowActions,
    );
    const row = container.querySelector('[data-block-id="user-m1"]')!;
    await act(async () => {
      flushSync(() => {
        click(row.querySelector('[data-row-action="edit"]')!);
      });
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea');
    expect(textarea?.value).toBe('original text');
    // The attachment note explains the full-replacement semantics.
    expect(container.querySelector('[data-edit-editor]')?.textContent).toContain(
      'attachments are not carried over',
    );
    await act(async () => {
      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(textarea!, 'edited text');
        textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    await act(async () => {
      flushSync(() => {
        click(container.querySelector('[data-edit-submit]')!);
      });
    });
    expect(onEditMessage).toHaveBeenCalledOnce();
    const [block, text] = onEditMessage.mock.calls[0] as [{ text: string }, string];
    expect(block.text).toBe('original text');
    expect(text).toBe('edited text');
    // The editor closed on submit.
    expect(container.querySelector('[data-edit-editor]')).toBeNull();
  });

  it('disables mutating actions while the session is busy', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: true,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
        assistantBlock('assistant-m2-0', 'answer'),
      ],
      rowActions,
    );
    const edit = container.querySelector<HTMLButtonElement>('[data-row-action="edit"]');
    const regenerate = container.querySelector<HTMLButtonElement>('[data-row-action="regenerate"]');
    const copy = container.querySelector<HTMLButtonElement>('[data-row-action="copy"]');
    expect(edit?.disabled).toBe(true);
    expect(regenerate?.disabled).toBe(true);
    expect(copy?.disabled).toBe(false);
  });
});

describe('collapsible user message', () => {
  // jsdom has no layout: drive the overflow decision with prototype getters
  // keyed on the clamp class (clamped → clientHeight caps at 240px).
  function stubMetrics() {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return (this.textContent ?? '').length;
      },
    );
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        const full = (this.textContent ?? '').length;
        return this.classList.contains('max-h-60') ? Math.min(240, full) : full;
      },
    );
    return () => {
      scroll.mockRestore();
      client.mockRestore();
    };
  }

  it('shows no toggle for short messages', async () => {
    const restore = stubMetrics();
    const container = await renderTranscript([userBlock({ id: 'user-m1', text: 'short' })]);
    expect(container.querySelector('[data-collapsible-toggle]')).toBeNull();
    restore();
  });

  it('clamps overflowing messages and expands on toggle', async () => {
    const restore = stubMetrics();
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'x'.repeat(600) }),
    ]);
    const content = container.querySelector('[data-collapsible-content]')!;
    const toggle = container.querySelector('[data-collapsible-toggle]');
    expect(toggle).not.toBeNull();
    expect(content.className).toContain('max-h-60');
    expect(content.className).toContain('collapsed-content-fade');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      flushSync(() => {
        click(toggle!);
      });
    });
    expect(content.className).not.toContain('max-h-60');
    expect(content.className).not.toContain('collapsed-content-fade');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    restore();
  });
});

