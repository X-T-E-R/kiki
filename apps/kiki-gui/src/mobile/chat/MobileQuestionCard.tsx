import { useState } from 'react';

import type { QuestionAnswer, QuestionItem } from '@kiki/protocol';
import type { QuestionBlock } from '@kiki/session-core/session';

import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';

export type QuestionAnswers = Readonly<Record<string, QuestionAnswer>>;

interface MobileQuestionCardProps {
  readonly block: QuestionBlock;
  readonly onAnswer: (questionId: string, answers: QuestionAnswers) => Promise<void>;
  readonly onDismiss: (questionId: string) => Promise<void>;
  readonly onOpenWorkbench: () => void;
}

/** One tap answers a lone single-choice question; anything larger collects choices first. */
function answersDirectly(questions: readonly QuestionItem[]): boolean {
  return questions.length === 1 && questions[0]?.multi_select !== true;
}

function toAnswers(questions: readonly QuestionItem[], picks: Readonly<Record<string, readonly string[]>>): QuestionAnswers | undefined {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const chosen = picks[question.id] ?? [];
    if (chosen.length === 0) return undefined;
    answers[question.id] = question.multi_select === true
      ? { kind: 'multi', option_ids: [...chosen] }
      : { kind: 'single', option_id: chosen[0]! };
  }
  return answers;
}

export function MobileQuestionCard({ block, onAnswer, onDismiss, onOpenWorkbench }: MobileQuestionCardProps) {
  const { t } = useI18n();
  const [picks, setPicks] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [sending, setSending] = useState(false);
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

  const run = async (task: () => Promise<void>) => {
    if (sending) return;
    setSending(true);
    try {
      await task();
    } finally {
      setSending(false);
    }
  };

  const direct = answersDirectly(questions);
  const ready = toAnswers(questions, picks);
  const allowsOther = questions.some((question) => question.allow_other === true);

  const choose = (question: QuestionItem, optionId: string) => {
    if (direct) {
      void run(() => onAnswer(questionId, { [question.id]: { kind: 'single', option_id: optionId } }));
      return;
    }
    setPicks((prev) => {
      const current = prev[question.id] ?? [];
      const next = question.multi_select === true
        ? current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]
        : [optionId];
      return { ...prev, [question.id]: next };
    });
  };

  return (
    <div data-mobile-question={questionId} data-mobile-question-state="pending" className="rounded-2xl border border-hairline bg-panel p-3.5 shadow-xs">
      <div className="flex flex-col gap-4">
        {questions.map((question) => (
          <fieldset key={question.id} className="min-w-0">
            <legend className="mb-2.5 text-[15px] font-medium leading-snug text-ink">
              {question.header?.trim() ? (
                <span className="mb-0.5 block text-[12px] font-medium uppercase tracking-[0.04em] text-ink-faint">{question.header}</span>
              ) : null}
              {question.question}
            </legend>
            <div className="flex flex-col gap-2">
              {question.options.map((option) => {
                const selected = (picks[question.id] ?? []).includes(option.id);
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
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {direct ? null : (
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
