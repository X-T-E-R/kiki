import type { z } from 'zod';
import type {
  PortableSpaceCenterCommit,
  PortableSpaceCenterSourcesListResponse,
  PortableSpaceSourcesListResponse,
  PortableSpaceSubscriptionSyncResult,
} from '@kiki/protocol';
import { portableSpacesContract } from '../../contract/portable-spaces.js';
import type { HttpRestRequestOptions } from '../../core/facade/http-rest.js';
import type {
  PortableSpacesFacade,
  PortableSpaceViewRequestOptions,
} from '../../core/facade/portable-spaces.js';
import type { HttpRestTransport } from './rest.js';

function reqOpts(options?: HttpRestRequestOptions): { readonly signal?: AbortSignal; readonly timeoutMs?: number } {
  return options === undefined ? {} : { signal: options.signal, timeoutMs: options.timeoutMs };
}

function sourcePath(id: string, suffix = ''): string {
  return `/spaces/portable/sources/${encodeURIComponent(id)}${suffix}`;
}

export function createPortableSpacesFacade(transport: HttpRestTransport): PortableSpacesFacade {
  const c = portableSpacesContract;

  async function listSources(
    options: PortableSpaceViewRequestOptions & { readonly view: 'center-v1' },
  ): Promise<PortableSpaceCenterSourcesListResponse>;
  async function listSources(options?: HttpRestRequestOptions): Promise<PortableSpaceSourcesListResponse>;
  async function listSources(
    options?: PortableSpaceViewRequestOptions,
  ): Promise<PortableSpaceSourcesListResponse | PortableSpaceCenterSourcesListResponse>;
  async function listSources(
    options?: PortableSpaceViewRequestOptions,
  ): Promise<PortableSpaceSourcesListResponse | PortableSpaceCenterSourcesListResponse> {
    if (options?.view === 'center-v1') {
      return c.listSourcesCenter.output.parse(
        await transport.json(c.listSourcesCenter.path, {
          ...reqOpts(options),
          query: { view: 'center-v1' },
        }),
      );
    }
    return c.listSourcesLegacy.output.parse(
      await transport.json(c.listSourcesLegacy.path, reqOpts(options)),
    );
  }

  async function subscribe(
    input: z.input<typeof c.subscribeCenter.input>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceCenterCommit>;
  async function subscribe(
    input: z.input<typeof c.subscribeLegacy.input>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscriptionSyncResult>;
  async function subscribe(
    input: z.input<typeof c.subscribeCenter.input> | z.input<typeof c.subscribeLegacy.input>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceCenterCommit | PortableSpaceSubscriptionSyncResult> {
    if ('previewToken' in input) {
      const parsed = c.subscribeCenter.input.parse(input);
      return c.subscribeCenter.output.parse(
        await transport.json(c.subscribeCenter.path, {
          ...reqOpts(options),
          method: 'POST',
          query: { view: 'center-v1' },
          body: parsed,
        }),
      );
    }
    const parsed = c.subscribeLegacy.input.parse(input);
    return c.subscribeLegacy.output.parse(
      await transport.json(c.subscribeLegacy.path, {
        ...reqOpts(options),
        method: 'POST',
        body: parsed,
      }),
    );
  }

  async function syncSubscription(
    id: string,
    input: z.input<typeof c.syncSubscriptionCenterToken.input>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceCenterCommit>;
  async function syncSubscription(
    id: string,
    input: z.input<typeof c.syncSubscriptionCenterDirect.input> | undefined,
    options: PortableSpaceViewRequestOptions & { readonly view: 'center-v1' },
  ): Promise<PortableSpaceCenterCommit>;
  async function syncSubscription(
    id: string,
    input?: z.input<typeof c.syncSubscriptionLegacy.input>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscriptionSyncResult>;
  async function syncSubscription(
    id: string,
    input?:
      | z.input<typeof c.syncSubscriptionCenterToken.input>
      | z.input<typeof c.syncSubscriptionCenterDirect.input>
      | z.input<typeof c.syncSubscriptionLegacy.input>,
    options?: PortableSpaceViewRequestOptions,
  ): Promise<PortableSpaceCenterCommit | PortableSpaceSubscriptionSyncResult> {
    if (input !== undefined && 'previewToken' in input) {
      const parsed = c.syncSubscriptionCenterToken.input.parse(input);
      return c.syncSubscriptionCenterToken.output.parse(
        await transport.json(sourcePath(id, '/sync'), {
          ...reqOpts(options),
          method: 'POST',
          query: { view: 'center-v1' },
          body: parsed,
        }),
      );
    }
    if (options?.view === 'center-v1') {
      const parsed = c.syncSubscriptionCenterDirect.input.parse(input ?? {});
      return c.syncSubscriptionCenterDirect.output.parse(
        await transport.json(sourcePath(id, '/sync'), {
          ...reqOpts(options),
          method: 'POST',
          query: { view: 'center-v1' },
          body: parsed,
        }),
      );
    }
    const parsed = c.syncSubscriptionLegacy.input.parse(input ?? {});
    return c.syncSubscriptionLegacy.output.parse(
      await transport.json(sourcePath(id, '/sync'), {
        ...reqOpts(options),
        method: 'POST',
        body: parsed,
      }),
    );
  }

  return {
    listSources,
    registerSource: async (input, options) => c.registerSource.output.parse(
      await transport.json(c.registerSource.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.registerSource.input.parse(input),
      }),
    ),
    previewSubscribe: async (input, options) => c.previewSubscribe.output.parse(
      await transport.json(c.previewSubscribe.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.previewSubscribe.input.parse(input),
      }),
    ),
    subscribe,
    previewSource: async (id, input = {}, options) => c.previewSource.output.parse(
      await transport.json(sourcePath(id, '/preview'), {
        ...reqOpts(options),
        method: 'POST',
        body: c.previewSource.input.parse(input),
      }),
    ),
    syncSubscription,
    patchSource: async (id, input, options) => c.patchSource.output.parse(
      await transport.json(sourcePath(id), {
        ...reqOpts(options),
        method: 'PATCH',
        body: c.patchSource.input.parse(input),
      }),
    ),
    reorderSources: async (input, options) => c.reorderSources.output.parse(
      await transport.json(c.reorderSources.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.reorderSources.input.parse(input),
      }),
    ),
    previewRemoveSource: async (id, options) => c.previewRemoveSource.output.parse(
      await transport.json(sourcePath(id, '/remove-preview'), {
        ...reqOpts(options),
        method: 'POST',
        body: {},
      }),
    ),
    removeSource: async (id, options) => c.removeSource.output.parse(
      await transport.json(sourcePath(id), {
        ...reqOpts(options),
        method: 'DELETE',
      }),
    ),
    removeReviewedSource: async (id, input, options) => c.removeReviewedSource.output.parse(
      await transport.json(sourcePath(id), {
        ...reqOpts(options),
        method: 'DELETE',
        query: { view: 'center-v1' },
        body: c.removeReviewedSource.input.parse(input),
      }),
    ),
    inspect: async (input, options) => c.inspect.output.parse(
      await transport.json(c.inspect.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.inspect.input.parse(input),
      }),
    ),
    exportSpace: async (input, options) => c.exportSpace.output.parse(
      await transport.json(c.exportSpace.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.exportSpace.input.parse(input),
      }),
    ),
    preview: async (input, options) => c.preview.output.parse(
      await transport.json(c.preview.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.preview.input.parse(input),
      }),
    ),
    apply: async (input, options) => c.apply.output.parse(
      await transport.json(c.apply.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.apply.input.parse(input),
      }),
    ),
    pack: async (input, options) => c.pack.output.parse(
      await transport.json(c.pack.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.pack.input.parse({ ...input, action: 'pack' }),
      }),
    ),
    unpack: async (input, options) => c.unpack.output.parse(
      await transport.json(c.unpack.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.unpack.input.parse({ ...input, action: 'unpack' }),
      }),
    ),
    fork: async (input, options) => c.fork.output.parse(
      await transport.json(c.fork.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.fork.input.parse(input),
      }),
    ),
    delta: async (input, options) => c.delta.output.parse(
      await transport.json(c.delta.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.delta.input.parse(input),
      }),
    ),
    mutate: async (input, options) => c.mutate.output.parse(
      await transport.json(c.mutate.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.mutate.input.parse(input),
      }),
    ),
    rekey: async (input, options) => c.rekey.output.parse(
      await transport.json(c.rekey.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.rekey.input.parse(input),
      }),
    ),
    addRecipient: async (input, options) => c.addRecipient.output.parse(
      await transport.json(c.addRecipient.path, {
        ...reqOpts(options),
        method: 'POST',
        body: c.addRecipient.input.parse(input),
      }),
    ),
  };
}
