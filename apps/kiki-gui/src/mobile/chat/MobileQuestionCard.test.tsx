// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it } from 'vitest';

import type { QuestionAnswer, QuestionItem } from '@kiki/protocol';
import type { QuestionBlock } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { MobileQuestionCard, type QuestionAnswers } from './MobileQuestionCard';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterAll(() => {
  for (const root of roots) root.unmount();
  for (const container of containers) container.remove();
});

const TWO_OPTIONS = [
  { id: 'opt-a', label: 'Option A', description: 'First choice' },
  { id: 'opt-b', label: 'Option B', description: 'Second choice' },
] as const;

function makeQuestionBlock(questions: readonly QuestionItem[]): QuestionBlock {
  return {
    kind: 'question',
    id: 'qb-1',
    request: {
      question_id: 'q-req-1',
      session_id: 'session-1',
      created_at: '2026-11-23T00:00:00Z',
      questions: [...questions],
    },
    outcome: undefined,
  };
}

async function renderMobileCard(
  block: QuestionBlock,
  onAnswer: (questionId: string, answers: QuestionAnswers) => Promise<void> = async () => {},
  onDismiss: (questionId: string) => Promise<void> = async () => {},
  onOpenWorkbench: () => void = () => {},
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    flushSync(() => {
      root.render(
        <I18nProvider>
          <MobileQuestionCard
            block={block}
            onAnswer={onAnswer}
            onDismiss={onDismiss}
            onOpenWorkbench={onOpenWorkbench}
          />
        </I18nProvider>,
      );
    });
  });
  return container;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('MobileQuestionCard', () => {
  it('renders and submits free-form Other answers when allow_other is omitted', async () => {
    const submitted: Array<{ questionId: string; answers: Record<string, QuestionAnswer> }> = [];
    const container = await renderMobileCard(
      makeQuestionBlock([{ id: 'q1', question: 'Which approach?', options: [...TWO_OPTIONS] }]),
      async (questionId, answers) => {
        submitted.push({ questionId, answers: { ...answers } });
      },
    );

    const otherInput = container.querySelector<HTMLInputElement>('[data-mobile-question-other="q1"]');
    expect(otherInput).not.toBeNull();
    expect(container.querySelector('[data-mobile-question-workbench]')).not.toBeNull();

    await act(async () => {
      flushSync(() => {
        setNativeInputValue(otherInput!, '  Custom route  ');
      });
    });

    const submit = container.querySelector<HTMLButtonElement>('[data-mobile-question-submit]');
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);

    await act(async () => {
      flushSync(() => {
        submit!.click();
      });
    });

    expect(submitted).toEqual([
      {
        questionId: 'q-req-1',
        answers: {
          q1: { kind: 'other', text: 'Custom route' },
        },
      },
    ]);
  });

  it('omits Other controls when allow_other is explicitly false and submits single-choice in one tap', async () => {
    const submitted: Array<{ questionId: string; answers: Record<string, QuestionAnswer> }> = [];
    const container = await renderMobileCard(
      makeQuestionBlock([
        { id: 'q1', question: 'Strict choice?', options: [...TWO_OPTIONS], allow_other: false },
      ]),
      async (questionId, answers) => {
        submitted.push({ questionId, answers: { ...answers } });
      },
    );

    expect(container.querySelector('[data-mobile-question-other="q1"]')).toBeNull();
    expect(container.querySelector('[data-mobile-question-workbench]')).toBeNull();

    const optB = container.querySelector<HTMLButtonElement>('[data-mobile-question-option="opt-b"]');
    expect(optB).not.toBeNull();
    await act(async () => {
      flushSync(() => {
        optB!.click();
      });
    });

    expect(submitted).toEqual([
      {
        questionId: 'q-req-1',
        answers: {
          q1: { kind: 'single', option_id: 'opt-b' },
        },
      },
    ]);
  });

  it('combines preset selection and Other note into multi_with_other', async () => {
    const submitted: Array<{ questionId: string; answers: Record<string, QuestionAnswer> }> = [];
    const container = await renderMobileCard(
      makeQuestionBlock([
        { id: 'q1', question: 'Select items', options: [...TWO_OPTIONS], multi_select: true },
      ]),
      async (questionId, answers) => {
        submitted.push({ questionId, answers: { ...answers } });
      },
    );

    const optA = container.querySelector<HTMLButtonElement>('[data-mobile-question-option="opt-a"]')!;
    const otherInput = container.querySelector<HTMLInputElement>('[data-mobile-question-other="q1"]')!;
    await act(async () => {
      flushSync(() => {
        optA.click();
      });
    });
    await act(async () => {
      flushSync(() => {
        setNativeInputValue(otherInput, 'plus extra');
      });
    });
    const submit = container.querySelector<HTMLButtonElement>('[data-mobile-question-submit]')!;
    await act(async () => {
      flushSync(() => {
        submit.click();
      });
    });

    expect(submitted).toEqual([
      {
        questionId: 'q-req-1',
        answers: {
          q1: { kind: 'multi_with_other', option_ids: ['opt-a'], other_text: 'plus extra' },
        },
      },
    ]);
  });
});
