import { z } from 'zod';

import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { isAbortError } from '#/_base/utils/abort';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IRoomService } from '#/app/room/room';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IConfigService } from '#/app/config/config';
import { INTERACTION_SECTION, type InteractionConfig } from './configSection';
import type { QuestionAnsweredEvent, QuestionDismissedEvent } from '#/app/telemetry/events';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { ISessionQuestionService } from '#/session/question/question';
import { isInteractionCancellation } from '#/session/interaction/interaction';
import type {
  QuestionAnswers,
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionResult,
} from '#/session/question/question';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionInputSchemaWithBackground,
  IAskUserQuestionTool,
  questionUniquenessError,
  type AskUserQuestionInput,
} from './ask-user-question';
import DESCRIPTION from './ask-user.md?raw';
import { QuestionBackgroundTask } from './question-background-task';
import { IQuestionFrequencyGuard, QUESTION_FREQUENCY_REMINDER, type QuestionAdmission } from './questionFrequencyGuard';

const QUESTION_DISMISSED_MESSAGE = 'User dismissed the question without answering.';

const QUESTION_UNSUPPORTED_FAILURE_MESSAGE =
  'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';

export class AskUserQuestionTool implements IAskUserQuestionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AskUserQuestion' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  private readonly activeCalls = new Map<string, Promise<ExecutableToolResult>>();
  private readonly recentCalls = new Map<string, Promise<ExecutableToolResult>>();

  constructor(
    @ISessionQuestionService private readonly question: ISessionQuestionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IConfigService private readonly config: IConfigService,
    @ref(ISessionDeliveryService) private readonly delivery?: LiveRef<ISessionDeliveryService>,
    @ref(ISessionMetadata) private readonly metadata?: LiveRef<ISessionMetadata>,
    @ref(IAgentActivityView) private readonly activity?: LiveRef<IAgentActivityView>,
    @ref(IRoomService) private readonly rooms?: LiveRef<IRoomService>,
    @ref(IQuestionFrequencyGuard) private readonly frequency?: LiveRef<IQuestionFrequencyGuard>,
  ) {
    this.description = this.isBlocking()
      ? DESCRIPTION
      : `${DESCRIPTION}- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.`;
    this.parameters = toInputJsonSchema(this.inputSchema());
  }

  private isBlocking(): boolean {
    return this.delivery?.current?.effectiveMode() !== 'message' &&
      this.config.get<InteractionConfig | undefined>(INTERACTION_SECTION)?.askUserQuestion === 'blocking';
  }

  resolveExecution(args: AskUserQuestionInput): ToolExecution {
    const isBackground = args.background === true && !this.isBlocking();
    return {
      description: isBackground
        ? `Starting background question: ${questionDescription(args.questions)}`
        : 'Asking user questions',
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private execution(args: AskUserQuestionInput, context: ExecutableToolContext): Promise<ExecutableToolResult> {
    if (this.frequency?.current === undefined) return this.executeOnce(args, context);
    const key = `${context.turnId}:${context.toolCallId}`;
    const existing = this.activeCalls.get(key) ?? this.recentCalls.get(key);
    if (existing !== undefined) return existing;
    const pending = this.executeOnce(args, context);
    this.activeCalls.set(key, pending);
    const remember = (): void => {
      this.activeCalls.delete(key);
      this.recentCalls.set(key, pending);
      if (this.recentCalls.size > 128) this.recentCalls.delete(this.recentCalls.keys().next().value!);
    };
    void pending.then(remember, remember);
    return pending;
  }

  private async executeOnce(
    args: AskUserQuestionInput,
    { toolCallId, signal, turnId, step, trace }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const guard = this.frequency?.current;
    const attempt = guard?.attempt({ turnId, step });
    const uniquenessError = questionUniquenessError(args.questions);
    if (uniquenessError !== null) {
      return { isError: true, output: uniquenessError };
    }

    const metadata = await this.metadata?.current?.read();
    signal.throwIfAborted();
    const roomId = metadata?.custom?.['room_member_of'];
    let room: { id: string; sessionId: string } | undefined;
    if (typeof roomId === 'string') {
      const turn = this.activity?.current?.state().turn;
      if (turn?.turnId !== turnId || turn.origin.kind !== 'room_message' || turn.origin.roomId !== roomId || !turn.origin.targeted) {
        return { isError: true, output: 'Only the currently awakened room member may ask a question.' };
      }
      if (this.rooms?.current === undefined) return { isError: true, output: 'Room questions are unavailable.' };
      room = { id: roomId, sessionId: metadata!.id };
    }
    const admission = attempt === undefined ? undefined : guard!.admit(attempt);
    if (guard !== undefined && admission === undefined) return { isError: true, output: QUESTION_FREQUENCY_REMINDER };
    const messageMode = this.delivery?.current?.effectiveMode() === 'message';
    if (messageMode || (args.background === true && !this.isBlocking())) {
      return this.executeInBackground({ ...args, background: true }, { toolCallId, turnId, signal, trace }, room, admission);
    }

    return this.executeQuestion(this.isBlocking() ? { ...args, background: false } : args, { toolCallId, turnId, signal, trace }, room, admission);
  }

  private inputSchema(): z.ZodType<AskUserQuestionInput> {
    return this.isBlocking() ? AskUserQuestionInputSchema : AskUserQuestionInputSchemaWithBackground;
  }

  private executeInBackground(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
      trace,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId' | 'trace'>,
    room?: { readonly id: string; readonly sessionId: string },
    admission?: QuestionAdmission,
  ): ExecutableToolResult {
    if (signal.aborted) {
      admission?.release();
      signal.throwIfAborted();
    }

    const description = questionDescription(args.questions);
    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new QuestionBackgroundTask(
          (taskSignal) => this.executeQuestion(args, { toolCallId, turnId, signal: taskSignal, trace }, room, admission),
          description,
          { questionCount: args.questions.length, toolCallId },
        ),
        { detached: true },
      );
    } catch (error) {
      admission?.release();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    return {
      isError: false,
      output:
        `task_id: ${taskId}\n` +
        `description: ${description}\n` +
        `status: ${status}\n` +
        `automatic_notification: true\n` +
        'next_step: Continue your current work; the answer will arrive automatically when the user responds.',
    };
  }

  private async executeQuestion(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
      trace,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId' | 'trace'>,
    room?: { readonly id: string; readonly sessionId: string },
    admission?: QuestionAdmission,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const request = () => this.question.request(
        {
          turnId,
          toolCallId,
          questions: args.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options.map((o) => ({
              label: o.label,
              description: o.description,
            })),
            multiSelect: q.multi_select,
          })),
        },
        { signal, agentId: this.scopeContext.agentId, detached: args.background === true, onAccepted: admission?.accepted },
      );
      const result = room === undefined
        ? await request()
        : await this.rooms!.current!.runQuestion(room.id, room.sessionId, request, signal);

      if (isInteractionCancellation(result)) {
        return {
          isError: true,
          output: JSON.stringify({ cancelled: true, reason: result.reason, note: 'The question ended without a user answer. This is not a user dismissal or authorization.' }),
        };
      }
      const normalized = normalizeQuestionResult(result);
      if (normalized === null || Object.keys(normalized.answers).length === 0) {
        const properties: QuestionDismissedEvent = {
          trace_id: trace?.traceId,
        };
        this.telemetry.track2('question_dismissed', properties);
        return dismissedQuestionResult();
      }

      const properties: QuestionAnsweredEvent = {
        answered: Object.keys(normalized.answers).length,
        trace_id: trace?.traceId,
      };
      if (normalized.method !== undefined) properties.method = normalized.method;
      this.telemetry.track2('question_answered', properties);
      return {
        isError: false,
        output: JSON.stringify({ answers: normalized.answers }),
      };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;

      if (error instanceof Error2 && error.code === CoreErrors.codes.NOT_IMPLEMENTED) {
        return {
          isError: true,
          output: QUESTION_UNSUPPORTED_FAILURE_MESSAGE,
        };
      }

      return {
        isError: true,
        output: `Question failed before receiving an answer: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      admission?.release();
    }
  }
}

registerAgentToolService(IAskUserQuestionTool, AskUserQuestionTool, {
  name: 'AskUserQuestion',
  domain: 'questionTools',
});

function questionDescription(questions: AskUserQuestionInput['questions']): string {
  const first = questions[0]?.question.trim();
  const label = first === undefined || first.length === 0 ? 'Ask user question' : first;
  if (questions.length <= 1) return label;
  return `${label} (+${String(questions.length - 1)} more)`;
}

function dismissedQuestionResult(): ExecutableToolResult {
  return {
    isError: false,
    output: JSON.stringify({
      answers: {},
      note: QUESTION_DISMISSED_MESSAGE,
    }),
  };
}

function normalizeQuestionResult(
  result: QuestionResult,
): { readonly answers: QuestionAnswers; readonly method?: QuestionAnswerMethod | undefined } | null {
  if (result === null || isInteractionCancellation(result)) return null;
  if (isQuestionResponse(result)) {
    return {
      answers: result.answers,
      method: result.method,
    };
  }
  return { answers: result };
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  if (typeof result !== 'object' || result === null) return false;
  if (!Object.hasOwn(result, 'answers')) return false;
  const answers = (result as { readonly answers?: unknown }).answers;
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers);
}
