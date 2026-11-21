/**
 * `sessionQuestionService` — ask-user request broker. Mirrors
 * `agent-core-v2/session/question/question.ts` (the in-process camelCase
 * representation; the snake_case protocol shape is adapted at the edge).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const questionOptionSchema = /* @__PURE__ */ z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const questionItemSchema = /* @__PURE__ */ z.object({
  question: z.string(),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean().optional(),
  otherLabel: z.string().optional(),
  otherDescription: z.string().optional(),
});

/** `QuestionAnswers = Record<string, string | true>`. */
export const questionAnswersSchema = /* @__PURE__ */ z.record(
  z.string(),
  z.union([z.string(), z.literal(true)]),
);

export const questionResponseSchema = /* @__PURE__ */ z.object({
  answers: questionAnswersSchema,
  method: z.enum(['enter', 'space', 'number_key']).optional(),
});

/** `QuestionResult = null | QuestionAnswers | QuestionResponse`. */
export const questionResultSchema = /* @__PURE__ */ z.union([
  z.null(),
  questionAnswersSchema,
  questionResponseSchema,
]);

export const questionRequestSchema = /* @__PURE__ */ z.object({
  id: z.string().optional(),
  turnId: z.number().optional(),
  toolCallId: z.string().optional(),
  questions: z.array(questionItemSchema),
});

export const sessionQuestionContract = {
  listPending: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(questionRequestSchema) }), 'input', 'output'),
  answer: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), questionResultSchema]), output: noResult }), 'input', 'output'),
  dismiss: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
