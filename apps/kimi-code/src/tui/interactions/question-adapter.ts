import type { QuestionResponse } from '@moonshot-ai/protocol';

import type { QuestionBlock } from '@kiki/session-core/session/transcript/types';

import type { QuestionPanelData, QuestionPanelResponse } from './types';

export function adaptQuestionRequest(block: QuestionBlock): QuestionPanelData {
  return {
    id: block.request.question_id,
    tool_call_id: block.request.tool_call_id ?? block.request.question_id,
    questions: block.request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      multi_select: question.multi_select ?? false,
      other_label: question.other_label,
      other_description: question.other_description,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function adaptQuestionResponse(
  block: QuestionBlock,
  response: QuestionPanelResponse,
): QuestionResponse['answers'] {
  const answers: QuestionResponse['answers'] = {};
  for (const [index, question] of block.request.questions.entries()) {
    const answer = response.answers[index];
    if (answer === undefined || answer === '') {
      answers[question.id] = { kind: 'skipped' };
      continue;
    }
    if (question.multi_select === true) {
      const values = answer.split(', ');
      const optionIds = question.options
        .filter((option) => values.includes(option.label))
        .map((option) => option.id);
      const other = values.filter(
        (value) => !question.options.some((option) => option.label === value),
      );
      answers[question.id] =
        other.length > 0
          ? { kind: 'multi_with_other', option_ids: optionIds, other_text: other.join(', ') }
          : { kind: 'multi', option_ids: optionIds };
      continue;
    }
    const option = question.options.find((candidate) => candidate.label === answer);
    answers[question.id] =
      option === undefined
        ? { kind: 'other', text: answer }
        : { kind: 'single', option_id: option.id };
  }
  return answers;
}
