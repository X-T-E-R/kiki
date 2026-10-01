// @vitest-environment jsdom

/**
 * ApprovalCard — external permission (ACP harness) slice.
 *
 * Covers the design-§9 contract: every option the agent offered is rendered
 * (open kind set, not a fixed three-button mapping), clicking one sends the
 * exact option id as `selectedOptionId`, cancel stays available, and a
 * payload that claims `external_permission` but fails validation fails closed
 * (cancel only, no approve path).
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { QuestionAnswer, QuestionItem } from '@kiki/protocol';
import { createViewState, projectAgentTranscriptView, type ApprovalBlock, type QuestionBlock } from '@kiki/session-core/session';
import { AgentTranscript, type InteractionState } from '@kiki/transcript';
import { I18nProvider } from '../i18n';
import { ApprovalCard, externalPermissionFromDisplay, InteractionRecord, QuestionCard } from './Interactions';
import { getToasts } from '../lib/toasts';

const configApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
}));
vi.mock('../state/connection', () => ({
  useOptionalConnection: () => ({ client: configApi }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterAll(() => {
  for (const root of roots) root.unmount();
  for (const container of containers) container.remove();
});

async function renderCard(
  block: ApprovalBlock,
  onResolve: (
    decision: 'approved' | 'rejected' | 'cancelled',
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>,
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  const node: ReactNode = <ApprovalCard block={block} onResolve={onResolve} />;
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
  return container;
}

function approvalBlock(display: unknown): ApprovalBlock {
  return {
    kind: 'approval',
    id: 'approval-ext-1',
    request: {
      approval_id: 'approval-ext-1',
      session_id: 'session_test',
      tool_call_id: 'call-ext-1',
      tool_name: 'grok__bash',
      action: 'Run shell command',
      tool_input_display: display,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
}

const EXTERNAL_DISPLAY = {
  kind: 'external_permission',
  summary: 'Grok wants to run: pnpm test',
  options: [
    { id: 'opt-once', label: 'Allow once', kind: 'allow_once' },
    {
      id: 'opt-always',
      label: 'Always allow pnpm',
      kind: 'allow_always',
      changes: [{ type: 'command_rule', command: 'pnpm test' }],
    },
    { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
    // Open set: kinds beyond the common four must still render and round-trip.
    { id: 'opt-plan', label: 'Approve plan review', kind: 'plan_review_accept' },
  ],
};

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function optionButtons(container: HTMLDivElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

describe('externalPermissionFromDisplay', () => {
  it('accepts a well-formed payload including unknown option kinds', () => {
    const parsed = externalPermissionFromDisplay(EXTERNAL_DISPLAY);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed?.ok !== true) throw new Error('expected ok');
    expect(parsed.display.options.map((option) => option.id)).toEqual([
      'opt-once',
      'opt-always',
      'opt-reject',
      'opt-plan',
    ]);
  });

  it('returns undefined for other display kinds', () => {
    expect(externalPermissionFromDisplay({ kind: 'command', command: 'ls' })).toBeUndefined();
    expect(externalPermissionFromDisplay(undefined)).toBeUndefined();
    expect(externalPermissionFromDisplay('external_permission')).toBeUndefined();
  });

  it('fails closed on malformed payloads', () => {
    expect(externalPermissionFromDisplay({ kind: 'external_permission', summary: '' , options: [] })).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({ kind: 'external_permission', summary: 'x', options: [] }),
    ).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({
        kind: 'external_permission',
        summary: 'x',
        options: [{ id: 'a', label: 'A' }],
      }),
    ).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({
        kind: 'external_permission',
        summary: 'x',
        options: [{ id: 'a', label: 'A', kind: 'allow_once', changes: 'nope' }],
      }),
    ).toEqual({ ok: false });
  });
});

describe('ApprovalCard external permission', () => {
  it('renders every agent-supplied option with kind chips and a changes disclosure', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(approvalBlock(EXTERNAL_DISPLAY), onResolve);

    expect(container.textContent).toContain('External agent permission');
    expect(container.textContent).toContain('Grok wants to run: pnpm test');
    const options = optionButtons(container);
    expect(options.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Allow once'),
      expect.stringContaining('Always allow pnpm'),
      expect.stringContaining('Reject'),
      expect.stringContaining('Approve plan review'),
    ]);
    // The unknown kind shows the raw kind string, not an invented label.
    expect(container.textContent).toContain('plan_review_accept');
    expect(container.textContent).toContain('1 granted change');
    // No native approve/reject/remember controls on the external card.
    expect(container.textContent).not.toContain('Remember for this session');
  });

  it('submits the exact option id with the mapped decision', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    const options = optionButtons(container);
    await act(async () => {
      flushSync(() => { click(options[1]!); });
    });
    expect(calls).toEqual([['approved', undefined, 'opt-always']]);
  });

  it('maps reject-ish kinds to a rejected decision with the exact id', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    await act(async () => {
      flushSync(() => { click(optionButtons(container)[2]!); });
    });
    expect(calls).toEqual([['rejected', undefined, 'opt-reject']]);
  });

  it('keeps cancel available and sends no option id', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    await act(async () => {
      flushSync(() => { click(cancel!); });
    });
    expect(calls).toEqual([['cancelled', undefined, undefined]]);
  });

  it('expands the changes disclosure to show what an option grants', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(approvalBlock(EXTERNAL_DISPLAY), onResolve);

    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('granted change') === true,
    );
    expect(toggle).toBeDefined();
    expect(container.textContent).not.toContain('command_rule');
    await act(async () => {
      flushSync(() => { click(toggle!); });
    });
    expect(container.textContent).toContain('command_rule');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('fails closed on an unrecognizable payload: cancel only, no options', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(
      approvalBlock({ kind: 'external_permission', summary: 'broken', options: 'nope' }),
      onResolve,
    );

    expect(optionButtons(container)).toEqual([]);
    expect(container.textContent).toContain('could not be recognized');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel']);

    await act(async () => {
      flushSync(() => { click(buttons[0]!); });
    });
    expect(onResolve).toHaveBeenCalledWith('cancelled', undefined, undefined);
  });
});

describe('ApprovalCard plan_enter', () => {
  const PLAN_ENTER_BLOCK: ApprovalBlock = {
    kind: 'approval',
    id: 'approval-plan-1',
    request: {
      approval_id: 'approval-plan-1',
      session_id: 'session_test',
      tool_call_id: 'call-plan-1',
      tool_name: 'EnterPlanMode',
      action: 'Enter plan mode',
      tool_input_display: { kind: 'plan_enter' },
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };

  it('renders the plan-enter title and timeout copy, not a raw JSON detail', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(PLAN_ENTER_BLOCK, onResolve);

    expect(container.textContent).toContain('Enter plan mode?');
    expect(container.textContent).toContain('rejected automatically');
    // No JSON dump of the payload, and the ordinary approve/reject row stays.
    expect(container.textContent).not.toContain('"kind"');
    expect(container.textContent).toContain('Approve');
    expect(container.textContent).toContain('Reject');
  });

  it('approves through the ordinary decision path', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(PLAN_ENTER_BLOCK, (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve();
    });

    const approve = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.startsWith('Approve') === true,
    );
    await act(async () => {
      flushSync(() => { click(approve!); });
    });
    expect(calls).toEqual([['approved', undefined, undefined]]);
  });

  it('offers no "always allow" for a plan-mode switch', async () => {
    const container = await renderCard({ ...PLAN_ENTER_BLOCK, request: { ...PLAN_ENTER_BLOCK.request, approval_rule: 'EnterPlanMode' } },
      () => Promise.resolve());
    expect(container.querySelector('[data-approval-always-allow]')).toBeNull();
  });
});

describe('ApprovalCard always allow', () => {
  const COMMAND_BLOCK: ApprovalBlock = {
    kind: 'approval',
    id: 'approval-cmd-1',
    request: {
      approval_id: 'approval-cmd-1',
      session_id: 'session_test',
      tool_call_id: 'call-cmd-1',
      tool_name: 'Bash',
      action: 'Run git status',
      tool_input_display: { kind: 'command', command: 'git status' },
      approval_rule: 'Bash(git status)',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
  const existing = { decision: 'deny' as const, scope: 'user' as const, pattern: 'Bash(rm -rf*)' };

  it('saves a persistent allow rule, then approves this call once', async () => {
    configApi.getConfig.mockResolvedValue({ permission: { rules: [existing] } });
    configApi.patchConfig.mockImplementation((patch: unknown) => Promise.resolve(patch));
    const calls: unknown[][] = [];
    const container = await renderCard(COMMAND_BLOCK, (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve();
    });
    const button = container.querySelector<HTMLButtonElement>('[data-approval-always-allow]')!;
    expect(button.textContent).toBe('Always allow');
    await act(async () => { click(button); });
    expect(configApi.patchConfig).toHaveBeenCalledWith({ permission: { rules: [
      existing, { decision: 'allow', scope: 'user', pattern: 'Bash(git status)' },
    ] } });
    expect(calls).toEqual([['approved']]);
    const note = container.querySelector('[data-approval-rule-saved]');
    expect(note?.textContent).toContain('Bash(git status)');
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('/settings/permissions');
    expect(getToasts().at(-1)).toMatchObject({ tone: 'success', retry: { label: 'Manage rules' } });
  });

  it('approves nothing when the rule cannot be saved', async () => {
    configApi.getConfig.mockResolvedValue({ permission: { rules: [] } });
    configApi.patchConfig.mockRejectedValue(new Error('write failed'));
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard({ ...COMMAND_BLOCK, id: 'approval-cmd-2',
      request: { ...COMMAND_BLOCK.request, approval_id: 'approval-cmd-2' } }, onResolve);
    await act(async () => { click(container.querySelector('[data-approval-always-allow]')!); });
    expect(onResolve).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save the rule');
    expect(container.querySelector('[data-approval-always-allow]')?.hasAttribute('disabled')).toBe(false);
  });

  it('hides the action when the request carries no rule', async () => {
    const { approval_rule: _rule, ...request } = COMMAND_BLOCK.request;
    void _rule;
    const container = await renderCard({ ...COMMAND_BLOCK, request }, () => Promise.resolve());
    expect(container.querySelector('[data-approval-always-allow]')).toBeNull();
  });
});

describe('QuestionCard', () => {
  function questionBlock(items: QuestionItem[]): QuestionBlock {
    return {
      kind: 'question',
      id: 'question-1',
      request: {
        question_id: 'question-1',
        session_id: 'session_test',
        questions: items,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      outcome: undefined,
    };
  }

  const TWO_OPTIONS = [
    { id: 'opt-a', label: 'Option A' },
    { id: 'opt-b', label: 'Option B' },
  ];

  async function renderQuestion(
    block: QuestionBlock,
    onAnswer: (answers: Record<string, QuestionAnswer>) => Promise<void>,
  ): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);
    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <I18nProvider>
              <QuestionCard block={block} onAnswer={onAnswer} onDismiss={() => Promise.resolve()} />
            </I18nProvider>
          </MemoryRouter>,
        );
      });
    });
    return container;
  }

  function optionButton(container: HTMLDivElement, label: string): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
      (button) => button.textContent?.includes(label),
    )!;
  }

  function submitButton(container: HTMLDivElement): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Submit',
    )!;
  }

  function otherInput(container: HTMLDivElement): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[aria-label="Other"]')!;
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('shows expiry only from terminal lifecycle state, never from 30 seconds of pending time', async () => {
    const transcript = new AgentTranscript('main');
    const createdAt = '2026-01-01T00:00:00.000Z';
    const onAnswer = vi.fn(() => Promise.resolve());
    const onDismiss = vi.fn(() => Promise.resolve());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(createdAt));
    let view = createViewState('session_test');
    const project = (state: InteractionState): QuestionBlock => {
      transcript.apply([{ op: 'interaction.upsert', interaction: {
        interactionId: 'question-lifecycle', interactionKind: 'question', state,
        request: { created_at: createdAt, questions: [{ id: 'q1', question: 'Pick one', options: TWO_OPTIONS }] },
      } }]);
      view = projectAgentTranscriptView(view, 'main', transcript.snapshot());
      const block = view.blocks.find((entry): entry is QuestionBlock => entry.kind === 'question');
      if (block === undefined) throw new Error('Expected a projected question card');
      return block;
    };
    try {
      const container = await renderQuestion(project('pending'), onAnswer);
      const root = roots.at(-1)!;
      const render = async (block: QuestionBlock) => {
        await act(async () => {
          flushSync(() => { root.render(<I18nProvider><QuestionCard block={block} onAnswer={onAnswer} onDismiss={onDismiss} /></I18nProvider>); });
        });
      };
      for (const elapsed of [29_999, 30_001, 120_000]) {
        clock.mockReturnValue(Date.parse(createdAt) + elapsed);
        await render(project('pending'));
        expect(container.querySelector('[data-question-history]')).toBeNull();
        expect(optionButton(container, 'Option A')).toBeDefined();
        expect(container.textContent).not.toContain('Question expired');
      }
      await render(project('answered'));
      expect(container.textContent).toContain('Question answered');
      expect(container.textContent).not.toContain('Question expired');
      await render(project('dismissed'));
      expect(container.textContent).toContain('Question dismissed');
      expect(container.textContent).not.toContain('Question expired');
      await render(project('cancelled'));
      expect(container.querySelector('[data-question-history] summary')?.textContent).toBe('Question expired');
      expect(container.querySelector('button[aria-pressed]')).toBeNull();
      expect(onAnswer).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('always renders the Other input, even without allow_other', async () => {
    const container = await renderQuestion(
      questionBlock([{ id: 'q1', question: 'Pick one', options: TWO_OPTIONS }]),
      () => Promise.resolve(),
    );
    expect(otherInput(container)).not.toBeNull();
  });

  it('multi-selects options on a single-choice item and submits kind multi', async () => {
    const answered: Record<string, QuestionAnswer>[] = [];
    const container = await renderQuestion(
      questionBlock([{ id: 'q1', question: 'Pick one', options: TWO_OPTIONS }]),
      (answers) => { answered.push(answers); return Promise.resolve(); },
    );
    await act(async () => {
      flushSync(() => { click(optionButton(container, 'Option A')); });
    });
    await act(async () => {
      flushSync(() => { click(optionButton(container, 'Option B')); });
    });
    expect(optionButton(container, 'Option A').getAttribute('aria-pressed')).toBe('true');
    expect(optionButton(container, 'Option B').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      flushSync(() => { click(submitButton(container)); });
    });
    expect(answered).toEqual([{ q1: { kind: 'multi', option_ids: ['opt-a', 'opt-b'] } }]);
  });

  it('combines checked options with a note into multi_with_other', async () => {
    const answered: Record<string, QuestionAnswer>[] = [];
    const container = await renderQuestion(
      questionBlock([{ id: 'q1', question: 'Pick', options: TWO_OPTIONS, multi_select: true }]),
      (answers) => { answered.push(answers); return Promise.resolve(); },
    );
    await act(async () => {
      flushSync(() => { click(optionButton(container, 'Option A')); });
    });
    await act(async () => {
      flushSync(() => { typeInto(otherInput(container), '  with a twist  '); });
    });
    await act(async () => {
      flushSync(() => { click(submitButton(container)); });
    });
    expect(answered).toEqual([
      { q1: { kind: 'multi_with_other', option_ids: ['opt-a'], other_text: 'with a twist' } },
    ]);
  });

  it('submits an other-only answer with zero options selected', async () => {
    const answered: Record<string, QuestionAnswer>[] = [];
    const container = await renderQuestion(
      questionBlock([{ id: 'q1', question: 'Pick', options: TWO_OPTIONS }]),
      (answers) => { answered.push(answers); return Promise.resolve(); },
    );
    await act(async () => {
      flushSync(() => { typeInto(otherInput(container), 'none of these'); });
    });
    expect(submitButton(container).disabled).toBe(false);
    await act(async () => {
      flushSync(() => { click(submitButton(container)); });
    });
    expect(answered).toEqual([{ q1: { kind: 'other', text: 'none of these' } }]);
  });

  it('keeps submit disabled while every item is unanswered', async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const container = await renderQuestion(
      questionBlock([{ id: 'q1', question: 'Pick', options: TWO_OPTIONS }]),
      onAnswer,
    );
    const submit = submitButton(container);
    expect(submit.disabled).toBe(true);
    expect(container.textContent).toContain('still unanswered');
    await act(async () => {
      flushSync(() => { click(submit); });
    });
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('InteractionRecord (tray placement)', () => {
  it('renders one line with the subject and a Review action that reports the wire id', async () => {
    const onReview = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);
    await act(async () => {
      flushSync(() => {
        root.render(
          <I18nProvider>
            <InteractionRecord block={approvalBlock(undefined)} originName="helper" onReview={onReview} />
          </I18nProvider>,
        );
      });
    });
    const record = container.querySelector('[data-interaction-record="approval-ext-1"]');
    expect(record?.textContent).toContain('helper · grok__bash · Run shell command');
    expect(record?.textContent).toContain('Awaiting approval');
    // No decision controls in the timeline — the tray owns them.
    expect(container.textContent).not.toContain('Approve');
    const review = container.querySelector<HTMLButtonElement>('button[aria-label="Review this request above the composer"]');
    expect(review).not.toBeNull();
    await act(async () => { flushSync(() => { click(review!); }); });
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
