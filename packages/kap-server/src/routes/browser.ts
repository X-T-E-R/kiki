import { IBrowserConnectionStore, IBrowserControlService, isError2, isBrowserOperation, browserToolGroup, type Scope } from '@kiki/agent-core-v2';
import { ErrorCode, browserIdSchema, browserConnectionInputSchema, browserConnectionResponseSchema,
  browserDefaultInputSchema, browserControlListSchema, browserStatusSchema, browserFailureSchema,
  browserTabsResponseSchema, browserCatalogResponseSchema, browserCatalogQuerySchema } from '@kiki/protocol';
import { z } from 'zod';

import { okEnvelope, errEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

type Handler = (req: { id: string; params: unknown; body: unknown }, reply: { send(value: unknown): unknown }) => void | Promise<void>;
interface BrowserRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  put(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
}
const browserRouteErrors = { [ErrorCode.VALIDATION_FAILED]: { detailsSchema: browserFailureSchema }, [ErrorCode.INTERNAL_ERROR]: { detailsSchema: browserFailureSchema } };
function protect(handler: Handler): Handler {
  return async (req, reply) => {
    try { await handler(req, reply); }
    catch (error) {
      const failure = browserFailureSchema.safeParse(isError2(error) ? { code: error.code, reason: error.details?.['reason'] } : {});
      const validation = failure.success && /^browser\.(?:invalid|not_found|disabled|busy|disconnected|target)$/.test(failure.data.code);
      const message = validation && error instanceof Error ? error.message : 'Browser request failed; configuration was retained where the operation did not complete';
      reply.send({ ...errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR, message, req.id),
        details: failure.success ? failure.data : { code: 'browser.execution_failed' } });
    }
  };
}
export function registerBrowserRoutes(app: BrowserRouteHost, core: Scope): void {
  const control = () => core.accessor.get(IBrowserControlService);
  const store = () => core.accessor.get(IBrowserConnectionStore);
  const params = z.object({ id: browserIdSchema });
  const list = defineRoute({ method: 'GET', path: '/browser/connections', success: { data: browserControlListSchema }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    reply.send(okEnvelope(await control().list(), req.id));
  });
  app.get(list.path, list.options, protect(list.handler as Handler));
  const defaults = defineRoute({ method: 'PUT', path: '/browser/default', body: browserDefaultInputSchema,
    success: { data: browserDefaultInputSchema }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    await store().setDefault(req.body.browser);
    reply.send(okEnvelope(req.body, req.id));
  });
  app.put(defaults.path, defaults.options, protect(defaults.handler as Handler));
  const upsert = defineRoute({ method: 'PUT', path: '/browser/connections/{id}', params, body: browserConnectionInputSchema,
    success: { data: browserConnectionResponseSchema }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    reply.send(okEnvelope({ connection: await control().upsert(req.params.id, req.body) }, req.id));
  });
  app.put(upsert.path, upsert.options, protect(upsert.handler as Handler));
  const remove = defineRoute({ method: 'DELETE', path: '/browser/connections/{id}', params,
    success: { data: z.object({ removed: z.literal(true) }) }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    await control().remove(req.params.id);
    reply.send(okEnvelope({ removed: true }, req.id));
  });
  app.delete(remove.path, remove.options, protect(remove.handler as Handler));
  const actionParams = z.object({ tail: z.string().min(1) });
  const status = defineRoute({ method: 'GET', path: '/browser/connections/{tail}', params: actionParams, querystring: browserCatalogQuerySchema,
    description: 'Status reads memory/config only. Tabs reads the explicitly connected daemon and never attaches or launches. Catalog may initialize a managed MCP process and its isolated configuration to discover schemas, but never launches Chromium; schemas are opt-in.',
    success: { data: z.union([browserStatusSchema, browserTabsResponseSchema, browserCatalogResponseSchema]) }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    const parsed = parseActionSuffix({ tail: req.params.tail, allowedActions: ['status', 'tabs', 'catalog'], resourceLabel: 'browser connection' });
    if (parsed.kind !== 'action' || !browserIdSchema.safeParse(parsed.id).success) {
      reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unsupported browser connection action', req.id), details: { code: 'browser.invalid' } });
      return;
    }
    if (parsed.action === 'tabs') {
      const tabs = await control().tabs(parsed.id);
      reply.send(okEnvelope({ browser: parsed.id, status: await control().status(parsed.id), tabs }, req.id));
    } else if (parsed.action === 'catalog') {
      const tools = await control().catalog(parsed.id);
      reply.send(okEnvelope({ browser: parsed.id, status: await control().status(parsed.id), backendToolCount: tools.length,
        contextIsolation: (await store().resolve(parsed.id)).type === 'codex-extension' ? 'official-extension-tab-ids' : 'opaque-context-through-window', capabilities: tools.map((tool) => ({ name: tool.name, description: tool.description,
          group: browserToolGroup(tool.name), surface: isBrowserOperation(tool.name) ? 'operation' : /^agent_browser_(?:connect|close|tab_|frame_|window_)/.test(tool.name) ? 'lifecycle' : 'administrative',
          inputSchema: req.query.includeSchema === 'true' ? tool.inputSchema : undefined })) }, req.id));
    } else reply.send(okEnvelope(await control().status(parsed.id), req.id));
  });
  app.get(status.path, status.options, protect(status.handler as Handler));
  const action = defineRoute({ method: 'POST', path: '/browser/connections/{tail}', params: actionParams,
    body: z.object({}).strict(), success: { data: browserStatusSchema }, errors: browserRouteErrors, tags: ['browser'] }, async (req, reply) => {
    const parsed = parseActionSuffix({ tail: req.params.tail, allowedActions: ['check', 'connect', 'disconnect'], resourceLabel: 'browser connection' });
    if (parsed.kind !== 'action' || !browserIdSchema.safeParse(parsed.id).success) {
      reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unsupported browser connection action', req.id), details: { code: 'browser.invalid' } });
      return;
    }
    const result = parsed.action === 'connect' ? await control().connect(parsed.id)
      : parsed.action === 'disconnect' ? await control().disconnect(parsed.id) : await control().check(parsed.id);
    reply.send(okEnvelope(result, req.id));
  });
  app.post(action.path, action.options, protect(action.handler as Handler));
}
