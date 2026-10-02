import { questionAnswerSchema, type QuestionItem } from '@kiki/protocol';

/** Read saved text answers and click responses into the same question-id map. */
export function questionAnswerTexts(questions: readonly QuestionItem[], raw: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const value = source[question.id] ?? source[question.question];
    if (typeof value === 'string') {
      answers[question.id] = value;
      continue;
    }
    const parsed = questionAnswerSchema.safeParse(value);
    if (!parsed.success) continue;
    const answer = parsed.data;
    const optionText = (id: string) => question.options.find((option) => option.id === id)?.label;
    switch (answer.kind) {
      case 'single': {
        const label = optionText(answer.option_id);
        if (label !== undefined) answers[question.id] = label;
        break;
      }
      case 'multi':
      case 'multi_with_other': {
        const labels = answer.option_ids.map(optionText);
        if (labels.some((label) => label === undefined)) break;
        answers[question.id] = [...labels, ...(answer.kind === 'multi_with_other' ? [answer.other_text] : [])].join(', ');
        break;
      }
      case 'other':
        answers[question.id] = answer.text;
        break;
      case 'skipped':
        break;
    }
  }
  return Object.keys(answers).length === 0 ? undefined : answers;
}
