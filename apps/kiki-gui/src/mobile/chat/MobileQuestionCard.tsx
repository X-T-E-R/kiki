import { useState } from 'react';

import type { QuestionAnswer, QuestionItem } from '@kiki/protocol';
import type { QuestionBlock } from '@kiki/session-core/session';

import { Icon } from '../../components/icons';
import {
  buildQuestionAnswers,
  questionAllowsOther,
  type QuestionItemAnswer,
} from '../../components/Interactions';
import { useI18n } from '../../i18n';

export type QuestionAnswers = Readonly<Record<string, QuestionAnswer>>;

interface MobileQuestionCardProps {
  readonly block: QuestionBlock;
  readonly onAnswer: (questionId: string, answers: QuestionAnswers) => Promise<void>;
  readonly onDismiss: (questionId: string) => Promise<void>;
  readonly onOpenWorkbench: () => void;
}

/** One tap answers a lone single-choice question when no Other text is entered. */
function answersDirectly(
  questions: readonly QuestionItem[],
  selections: Readonly<Record<string, QuestionItemAnswer>>,
): boolean {
  if (questions.length !== 1 || questions[0]?.multi_select === true) return false;
  const current = selections[questions[0]!.id];
  return (current?.otherText.trim() ?? '') === '';
}

export function MobileQuestionCard({ block, onAnswer, onDismiss, onOpenWorkbench }: MobileQuestionCardProps) {
  const { t } = useI18n();
  const [selections, setSelections] = useState<Readonly<Record<string, QuestionItemAnswer>>>({});
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const questionId = block.request.question_id;
  const questions = block.request.questions;
  const outcome = block.outcome;

  if (outcome !== undefined) {
    const answered = outcome.kind === 'answered' ? outcome.answers : undefined;
    return (
      <div data-mobile-question={questionId} data-mobile-question-state={outcome.kind} className="flex flex-col gap-1.5 border-l-2 border-hairline pl-3">
        {questions.map((question) => (
          <div key={question.id} className="min-w-0">
            <p className="text-[13px] text-ink-faint">{question.question}</p>
            <p className="text-[14px] text-ink-soft">
              {answered?.[question.id] ?? (outcome.kind === 'answered' ? t('mobile.question.answered') : t('mobile.question.closed'))}
            </p>
          </div>
        ))}
      </div>
    );
  }

  const answerFor = (id: string): QuestionItemAnswer =>
    selections[id] ?? { optionIds: [], otherText: '' };

  const run = async (task: () => Promise<void>) => {
    if (sending) return;
    setSending(true);
    setFailed(null);
    try {
      await task();
    } catch (error) {
      setFailed(
        error instanceof Error
          ? t('ia.answerFailed', { detail: error.message })
          : t('ia.answerFailedGeneric'),
      );
    } finally {
      setSending(false);
    }
  };

  const direct = answersDirectly(questions, selections);
  const ready = buildQuestionAnswers(questions, selections);
  const allowsOther = questions.some((question) => questionAllowsOther(question));

  const choose = (question: QuestionItem, optionId: string) => {
    if (direct) {
      void run(() => onAnswer(questionId, { [question.id]: { kind: 'single', option_id: optionId } }));
      return;
    }
    setSelections((prev) => {
      const current = prev[question.id] ?? { optionIds: [], otherText: '' };
      const nextIds = question.multi_select === true
        ? current.optionIds.includes(optionId)
          ? current.optionIds.filter((id) => id !== optionId)
          : [...current.optionIds, optionId]
        : current.optionIds.includes(optionId)
          ? []
          : [optionId];
      return { ...prev, [question.id]: { ...current, optionIds: nextIds } };
    });
  };

  const setOtherText = (questionIdKey: string, otherText: string) => {
    setSelections((prev) => {
      const current = prev[questionIdKey] ?? { optionIds: [], otherText: '' };
      return { ...prev, [questionIdKey]: { ...current, otherText } };
    });
  };

  return (
    <div data-mobile-question={questionId} data-mobile-question-state="pending" className="rounded-2xl border border-hairline bg-panel p-3.5 shadow-xs">
      <div className="flex flex-col gap-4">
        {questions.map((question) => {
          const selection = answerFor(question.id);
          const otherLabel = question.other_label ?? t('ia.other');
          return (
            <fieldset key={question.id} className="min-w-0">
              <legend className="mb-2.5 text-[15px] font-medium leading-snug text-ink">
                {question.header?.trim() ? (
                  <span className="mb-0.5 block text-[12px] font-medium uppercase tracking-[0.04em] text-ink-faint">{question.header}</span>
                ) : null}
                {question.question}
              </legend>
              <div className="flex flex-col gap-2">
                {question.options.map((option) => {
                  const selected = selection.optionIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={sending}
                      aria-pressed={direct ? undefined : selected}
                      data-mobile-question-option={option.id}
                      onClick={() => { choose(question, option.id); }}
                      className={`flex min-h-11 w-full flex-col justify-center rounded-xl border px-3.5 py-2 text-left transition-colors disabled:opacity-60 ${
                        selected ? 'border-ink bg-ink/[0.04]' : 'border-hairline bg-paper hover:border-hairline-strong'
                      }`}
                    >
                      <span className="text-[14px] font-medium text-ink">{option.label}</span>
                      {option.description?.trim() ? (
                        <span className="text-[12.5px] leading-snug text-ink-faint">{option.description}</span>
                      ) : null}
                    </button>
                  );
                })}
                {questionAllowsOther(question) ? (
                  <label className="flex flex-col gap-1 pt-0.5">
                    <span className="text-[12.5px] font-medium text-ink-soft">{otherLabel}</span>
                    <input
                      type="text"
                      aria-label={otherLabel}
                      data-mobile-question-other={question.id}
                      disabled={sending}
                      placeholder={question.other_description ?? t('ia.otherPlaceholder')}
                      value={selection.otherText}
                      onChange={(event) => { setOtherText(question.id, event.target.value); }}
                      className="min-h-10 w-full rounded-xl border border-hairline bg-paper px-3.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
                    />
                  </label>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
      {failed !== null ? (
        <p role="alert" className="mt-2.5 text-[13px] text-danger">{failed}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {direct && ready === undefined ? null : (
          <button
            type="button"
            data-mobile-question-submit
            disabled={sending || ready === undefined}
            onClick={() => { if (ready !== undefined) void run(() => onAnswer(questionId, ready)); }}
            className="inline-flex h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep disabled:opacity-50"
          >
            <Icon name="check" size={14} />
            <span>{t('mobile.question.submit')}</span>
          </button>
        )}
        <button
          type="button"
          data-mobile-question-skip
          disabled={sending}
          onClick={() => { void run(() => onDismiss(questionId)); }}
          className="inline-flex h-11 items-center rounded-full border border-hairline bg-paper px-4 text-[14px] font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-60"
        >
          {t('mobile.question.skip')}
        </button>
        {allowsOther ? (
          <button
            type="button"
            data-mobile-question-workbench
            onClick={onOpenWorkbench}
            className="ml-auto inline-flex h-11 items-center gap-1 rounded-full px-2 text-[13.5px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            <span>{t('mobile.question.ownAnswer')}</span>
            <Icon name="chevron" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
