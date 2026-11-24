import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import {
  ErrorCodes,
  getLiveSessionById,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IConfigService,
  IModelService,
  IOutputLayerService,
  isError2,
  MAIN_AGENT_ID,
  type ContextMessage,
  type Scope,
  type TokenUsage,
} from '@kiki/agent-core-v2';
import { DEFAULT_MODEL_SECTION } from '@kiki/agent-core-v2/app/kosongConfig/configSection';
import { IModelCatalog } from '@kiki/agent-core-v2/kosong/model/catalog';
import {
  ErrorCode,
  llmCompleteRequestSchema,
  llmCompleteResponseSchema,
  validateSupportedOutputSchema,
} from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { IModelPricingService } from '../pricing/modelPricingService';
import { sessionAccessStore, sessionAccessToken } from '../services/sessionAccess/access';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { sendMappedError } from './_error';

type RouteHandler = (
  req: { id: string; body: unknown; headers?: Record<string, unknown> },
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

interface LlmCompleteRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: RouteHandler,
  ): unknown;
}

function wantsNdjson(headers?: Record<string, unknown>): boolean {
  const accept = headers?.['accept'];
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

function computeCostUsd(core: Scope, model: string, usage: TokenUsage): number | undefined {
  try {
    const pricing = core.accessor.get(IModelPricingService);
    return pricing.calculate(model, usage);
  } catch {
    return undefined;
  }
}

function resolveModelNameForPricing(core: Scope, requestedModel?: string): string | undefined {
  try {
    let modelId = requestedModel;
    if (modelId === undefined) {
      const configured = core.accessor.get(IConfigService)?.get<string | undefined>(DEFAULT_MODEL_SECTION);
      if (typeof configured === 'string' && configured.trim().length > 0) {
        modelId = configured;
      } else {
        const listed = core.accessor.get(IModelService)?.list();
        modelId = listed === undefined ? undefined : Object.keys(listed)[0];
      }
    }
    if (modelId === undefined) return undefined;
    const requester = core.accessor.get(IModelCatalog).getRequester(modelId);
    return requester.model.name;
  } catch {
    return requestedModel;
  }
}

/** Register stateless governed completion route `POST /llm:complete`. */
export function registerLlmCompleteRoutes(
  app: LlmCompleteRouteHost,
  core: Scope,
  broadcaster?: SessionEventBroadcaster,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/llm::complete',
      body: llmCompleteRequestSchema,
      success: { data: llmCompleteResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_CURSOR_MISMATCH]: {},
        [ErrorCode.RATE_LIMITED]: {},
      },
      description: 'Sessionless governed LLM completion with optional streaming and read-only context_from',
      tags: ['llm'],
      operationId: 'llmComplete',
    },
    async (req, response) => {
      const reply = response as FastifyReply;
      const token = sessionAccessToken(req);
      const accessStore = sessionAccessStore(req);
      if (token !== undefined && req.body.context_from !== undefined) {
        const authorized =
          token.scopes.includes('read') &&
          token.session_id !== undefined &&
          req.body.context_from.session_id === token.session_id;
        if (!authorized) {
          reply.code(403).send(errEnvelope(ErrorCode.AUTH_INVALID_TOKEN, 'session_access_scope', req.id));
          return;
        }
      }

      if (req.body.output_schema !== undefined) {
        const schemaIssues = validateSupportedOutputSchema(req.body.output_schema);
        if (schemaIssues.length > 0) {
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `Unsupported output_schema: ${schemaIssues.map((i) => `${i.path || '$'}: ${i.message}`).join('; ')}`,
              req.id,
            ),
          );
          return;
        }
      }

      let preloadedContextMessages: readonly ContextMessage[] | undefined;
      if (req.body.context_from?.as_of_seq !== undefined && broadcaster !== undefined) {
        const targetSessionId = req.body.context_from.session_id;
        const targetAgentId = req.body.context_from.agent_id ?? MAIN_AGENT_ID;
        const live = getLiveSessionById(core.accessor, targetSessionId);
        if (live !== undefined) {
          const snapState = await broadcaster.getSnapshotState(targetSessionId, {
            captureMessages: targetAgentId === MAIN_AGENT_ID,
            capture: targetAgentId === MAIN_AGENT_ID
              ? undefined
              : async () => {
                  const agent = live.accessor.get(IAgentLifecycleService).get(targetAgentId);
                  if (agent === undefined) return null;
                  return [...agent.accessor.get(IAgentContextMemoryService).get()];
                },
          });
          if (req.body.context_from.as_of_seq !== snapState.seq) {
            reply.send(
              errEnvelope(
                ErrorCode.SESSION_CURSOR_MISMATCH,
                `context_from.as_of_seq (${req.body.context_from.as_of_seq}) does not match current committed session watermark (${snapState.seq})`,
                req.id,
              ),
            );
            return;
          }
          if (targetAgentId === MAIN_AGENT_ID) {
            preloadedContextMessages = snapState.contextMessages;
          } else if (snapState.captured === null) {
            reply.send(
              errEnvelope(
                ErrorCode.VALIDATION_FAILED,
                `agent ${targetAgentId} does not exist in session ${targetSessionId}`,
                req.id,
              ),
            );
            return;
          } else {
            preloadedContextMessages = snapState.captured;
          }
        } else {
          const cursor = await broadcaster.getCursor(targetSessionId, undefined, true);
          if (req.body.context_from.as_of_seq !== cursor.seq) {
            reply.send(
              errEnvelope(
                ErrorCode.SESSION_CURSOR_MISMATCH,
                `context_from.as_of_seq (${req.body.context_from.as_of_seq}) does not match current committed session watermark (${cursor.seq})`,
                req.id,
              ),
            );
            return;
          }
        }
      }

      let releaseBudgetReservation: (() => void) | undefined;
      if (token !== undefined && accessStore !== undefined) {
        const inputEstimate = Math.max(1, Math.ceil(JSON.stringify(req.body.messages).length / 4));
        const outputEstimate = req.body.max_tokens ?? 0;
        const estimatedTokens = inputEstimate + outputEstimate;
        let estimatedCostUsd: number | undefined;
        if (token.budget?.max_cost_usd !== undefined) {
          const modelName = resolveModelNameForPricing(core, req.body.model);
          const pricingEstimate = modelName === undefined
            ? undefined
            : computeCostUsd(core, modelName, {
                inputOther: inputEstimate,
                output: outputEstimate,
                inputCacheRead: 0,
                inputCacheCreation: 0,
              });
          if (pricingEstimate === undefined) {
            reply.code(429).send(errEnvelope(ErrorCode.RATE_LIMITED, 'session_access_budget_cost_unpriced', req.id));
            return;
          }
          estimatedCostUsd = pricingEstimate;
        }
        const budgetCheck = accessStore.admitBudget(token, {
          tokens: estimatedTokens,
          ...(estimatedCostUsd === undefined ? {} : { costUsd: estimatedCostUsd }),
        });
        if (!budgetCheck.ok) {
          reply.code(429).send(errEnvelope(ErrorCode.RATE_LIMITED, budgetCheck.reason, req.id));
          return;
        }
        releaseBudgetReservation = budgetCheck.release;
      }

      const chargeUsage = (record: { readonly model: string; readonly usage: TokenUsage }): void => {
        if (token === undefined || accessStore === undefined) return;
        const totalTokens =
          record.usage.inputOther +
          record.usage.inputCacheRead +
          record.usage.inputCacheCreation +
          record.usage.output;
        const costUsd = computeCostUsd(core, record.model, record.usage);
        accessStore.recordBudgetUsage(token, {
          tokens: totalTokens,
          ...(costUsd === undefined ? {} : { costUsd }),
        });
      };

      const runOptions = {
        onUsage: chargeUsage,
        ...(preloadedContextMessages === undefined ? {} : { preloadedContextMessages }),
      };

      let handedOffToStream = false;
      try {
        const service = core.accessor.get(IOutputLayerService);
        if (req.body.stream === true) {
          const controller = new AbortController();
          const onClose = () => controller.abort();
          reply.raw.once('close', onClose);
          const ndjson = wantsNdjson((req as unknown as { headers?: Record<string, unknown> }).headers);
          const source = service.completeStream(req.body, controller.signal, runOptions);
          const encode = async function* (): AsyncIterable<string> {
            try {
              for await (const event of source) {
                if (ndjson) {
                  yield `${JSON.stringify(event)}\n`;
                } else {
                  yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
                }
              }
            } finally {
              releaseBudgetReservation?.();
              reply.raw.off('close', onClose);
            }
          };
          reply.header(
            'content-type',
            ndjson ? 'application/x-ndjson; charset=utf-8' : 'text/event-stream; charset=utf-8',
          );
          reply.header('cache-control', 'no-store');
          reply.header('x-accel-buffering', 'no');
          handedOffToStream = true;
          reply.send(Readable.from(encode()));
          return;
        }

        const controller = new AbortController();
        const onClose = () => controller.abort();
        reply.raw.once('close', onClose);
        try {
          const result = await service.complete(req.body, controller.signal, runOptions);
          reply.send(okEnvelope(result, req.id));
        } catch (error) {
          if (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, req.id));
            return;
          }
          if (isError2(error) && (error.code === ErrorCodes.REQUEST_INVALID || error.code === ErrorCodes.CONFIG_INVALID)) {
            reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
            return;
          }
          sendMappedError(reply, req.id, error, {
            fallback: { logMessage: 'llm:complete failed' },
          });
        } finally {
          reply.raw.off('close', onClose);
        }
      } finally {
        if (!handedOffToStream) releaseBudgetReservation?.();
      }
    },
  );
  app.post(route.path, route.options, route.handler as RouteHandler);
}
