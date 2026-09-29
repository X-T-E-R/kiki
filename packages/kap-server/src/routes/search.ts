import { type Scope } from '@kiki/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  searchMessagesBodySchema,
  searchMessagesResponseSchema,
  type SearchMessagesBody,
  type SearchMessagesResponse,
} from '../protocol/rest-search';
import type { GlobalSearchPage, GlobalSearchQuery } from '../search/contract';
import { GlobalSearchError, IGlobalSearchService } from '../search/searchService';

interface SearchRouteHost {
  get(path: string, options: { preHandler: unknown[] }, handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

function toServiceQuery(body: SearchMessagesBody): GlobalSearchQuery {
  return {
    query: body.query,
    mode: body.mode,
    op: body.op,
    container:
      body.container === undefined
        ? undefined
        : { sessionId: body.container.session_id, agentId: body.container.agent_id },
    workspaceId: body.workspace_id,
    role: body.role,
    startTime: body.start_time,
    endTime: body.end_time,
    sort: body.sort,
    pageSize: body.page_size,
    pageToken: body.page_token,
  };
}

function toWirePage(page: GlobalSearchPage): SearchMessagesResponse {
  return {
    items: page.items.map((hit) => ({
      session_id: hit.sessionId,
      workspace_id: hit.workspaceId,
      session_title: hit.sessionTitle,
      agent_id: hit.agentId,
      role: hit.role,
      snippet: hit.snippet,
      time: hit.time,
      turn: hit.turn,
      step_id: hit.stepId,
      score: hit.score,
    })),
    has_more: page.hasMore,
    page_token: page.pageToken,
    incomplete: page.incomplete,
    index_state: {
      state: page.indexState.state,
      indexed_sessions: page.indexState.indexedSessions,
      total_sessions: page.indexState.totalSessions,
      documents: page.indexState.documents,
      stale: page.indexState.stale,
      degraded: page.indexState.degraded,
      reason: page.indexState.reason,
    },
    source: page.source,
  };
}

export function registerSearchRoutes(app: SearchRouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/search',
      body: searchMessagesBodySchema,
      success: { data: searchMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description:
        'Global full-text search over user messages, assistant replies, tool results and session titles across all sessions',
      tags: ['search'],
    },
    async (req, reply) => {
      try {
        const page = await core.accessor.get(IGlobalSearchService).search(toServiceQuery(req.body));
        reply.send(okEnvelope(toWirePage(page), req.id));
      } catch (error) {
        if (
          error instanceof GlobalSearchError &&
          (error.reason === 'invalid_query' || error.reason === 'invalid_page_token')
        ) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id, error.stack));
          return;
        }
        requestLog(req)?.error({ err: error }, 'global search request failed');
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            req.id,
            error instanceof Error ? error.stack : undefined,
          ),
        );
      }
    },
  );
  app.post(route.path, route.options, route.handler as Parameters<SearchRouteHost['post']>[2]);
  app.get('/search/status', { preHandler: [] }, async (req, reply) => {
    const status = await core.accessor.get(IGlobalSearchService).status();
    const indexer = status.indexer;
    reply.send(okEnvelope({ index_state: indexer === undefined ? {
      state: status.lifecycle.state === 'ready' ? 'ready' :
        status.lifecycle.state === 'degraded' ? 'unavailable' : 'building',
      indexed_sessions: status.sessions, total_sessions: status.sessions,
      documents: status.documents, degraded: status.degraded,
    } : {
      state: status.lifecycle.detail === 'disabled' ? 'unavailable' : indexer.state,
      indexed_sessions: indexer.indexedSessions, total_sessions: indexer.totalSessions,
      documents: indexer.documents, stale: indexer.stale,
      reason: status.lifecycle.detail === 'disabled' ? 'disabled' : indexer.reason,
      retry_after_ms: indexer.retryAfterMs, writer: indexer.state !== 'readonly',
    } }, req.id));
  });
  app.post('/search/retry', { preHandler: [] }, (req, reply) => {
    core.accessor.get(IGlobalSearchService).retryIndexer();
    reply.send(okEnvelope({ retried: true }, req.id));
  });
}
