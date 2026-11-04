import questionCard from './question-card.scenario.mjs';
import { streamSteps, textOf } from './helpers.mjs';

const REPLY = 'Understood — continuing without a selection.';
const replyStart = questionCard.onPrompt.findIndex((step) => step.frame?.type === 'assistant.delta');
const replyEnd = questionCard.onPrompt.findLastIndex((step) => step.frame?.type === 'assistant.delta');
const questionCallId = questionCard.onPrompt.find((step) => (
  step.frame?.type === 'tool.call.started' && step.frame.payload?.name === 'AskUserQuestion'
))?.frame.payload.toolCallId;

export default {
  ...questionCard,
  onPrompt: questionCard.onPrompt.flatMap((step, index) => {
    if (index === replyStart) return streamSteps('assistant.delta', 1, REPLY, { per: 22 });
    if (index > replyStart && index <= replyEnd) return [];
    if (step.commit?.role === 'assistant') {
      return [{ ...step, commit: { ...step.commit, content: textOf(REPLY) } }];
    }
    if (step.frame?.type !== 'tool.result' || step.frame.payload?.toolCallId !== questionCallId) return [step];
    return [{
      ...step,
      frame: {
        ...step.frame,
        payload: {
          ...step.frame.payload,
          output: { answers: {}, note: 'User dismissed the question without answering.' },
        },
      },
    }];
  }),
};
