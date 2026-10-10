import type { FastifyInstance, HTTPMethods, RouteHandlerMethod, preHandlerHookHandler } from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { IRecipeService } from '@kiki/agent-core-v2/app/recipes/recipes';
import { z } from 'zod';
import { recipeExportSchema, recipeSummarySchema, recipeDetailSchema, recipePreviewSchema, recipeMarketSchema, recipePreviewInputSchema, recipeInstallInputSchema, recipeUpdateInputSchema, recipeForkInputSchema, recipeSaveLocalInputSchema, recipeRemoveInputSchema, recipeMarketInputSchema } from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../envelope';
import { defineRoute, type RouteDefinition } from '../middleware/defineRoute';

export function registerRecipesRoutes(app: FastifyInstance, core: Scope): void {
  const service = () => core.accessor.get(IRecipeService);
  const mount = <B extends z.ZodTypeAny | undefined, P extends z.ZodTypeAny | undefined, Q extends z.ZodTypeAny | undefined>(route: RouteDefinition<B, P, Q>) => {
    app.route({ method: route.method as HTTPMethods, url: route.path, schema: route.options.schema, preHandler: route.options.preHandler as preHandlerHookHandler[], handler: route.handler as unknown as RouteHandlerMethod });
  };
  const run = async (id: string, reply: { send(payload: unknown): unknown }, action: () => Promise<unknown>) => {
    try { reply.send(okEnvelope(await action() ?? null, id)); }
    catch (error) {
      const failure = error as { code?: string; message?: string; details?: unknown };
      reply.send({ ...errEnvelope(failure.code === 'validation.failed' || failure.code === 'request.invalid' || failure.code === 'config.revision_conflict' ? 40001 : 50001, failure.message ?? 'Recipe operation failed', id), details: failure.details });
    }
  };
  mount(defineRoute({ method: 'GET', path: '/recipes', success: { data: z.array(recipeSummarySchema) }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().list())));
  mount(defineRoute({ method: 'GET', path: '/recipes/{id}', params: z.object({ id: z.string() }), success: { data: recipeDetailSchema.nullable() }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().get(req.params.id))));
  mount(defineRoute({ method: 'GET', path: '/recipes/{id}/export', params: z.object({ id: z.string() }), success: { data: recipeExportSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().export(req.params.id))));
  mount(defineRoute({ method: 'POST', path: '/recipes::preview', body: recipePreviewInputSchema, success: { data: recipePreviewSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().preview(req.body))));
  mount(defineRoute({ method: 'POST', path: '/recipes::install', body: recipeInstallInputSchema, success: { data: recipeSummarySchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().install(req.body))));
  mount(defineRoute({ method: 'POST', path: '/recipes::check-updates', success: { data: z.array(recipeSummarySchema) }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().checkUpdates())));
  mount(defineRoute({ method: 'POST', path: '/recipes::update', body: recipeUpdateInputSchema, success: { data: recipeSummarySchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().update(req.body))));
  mount(defineRoute({ method: 'POST', path: '/recipes::fork', body: recipeForkInputSchema, success: { data: recipeDetailSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().fork(req.body))));
  mount(defineRoute({ method: 'POST', path: '/recipes::save-local', body: recipeSaveLocalInputSchema, success: { data: recipeDetailSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().saveLocal(req.body))));
  mount(defineRoute({ method: 'DELETE', path: '/recipes/{id}', params: z.object({ id: z.string() }), querystring: recipeRemoveInputSchema.omit({ installation_id: true }).extend({ disable_models: z.stringbool().optional() }), success: { data: z.null() }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().remove({ installation_id: req.params.id, ...req.query }))));
  mount(defineRoute({ method: 'GET', path: '/recipe-markets', success: { data: z.array(recipeMarketSchema) }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().listMarkets())));
  mount(defineRoute({ method: 'POST', path: '/recipe-markets', body: recipeMarketInputSchema, success: { data: recipeMarketSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().addMarket(req.body))));
  mount(defineRoute({ method: 'PUT', path: '/recipe-markets/{id}', params: z.object({ id: z.string() }), body: recipeMarketInputSchema.omit({ id: true }), success: { data: recipeMarketSchema }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().updateMarket({ ...req.body, id: req.params.id }))));
  mount(defineRoute({ method: 'DELETE', path: '/recipe-markets/{id}', params: z.object({ id: z.string() }), success: { data: z.null() }, tags: ['recipes'] }, (req, reply) => run(req.id, reply, () => service().removeMarket(req.params.id))));
}
