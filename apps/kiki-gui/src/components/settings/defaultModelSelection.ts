import type { QueryClient } from '@tanstack/react-query';
import { writeSettings } from '@kiki/session-core/settings';

import type { KikiClient, KikiConfigResponse } from '../../lib/client';

type DefaultModelClient = Pick<KikiClient, 'setDefaultModel' | 'patchConfig' | 'getConfig'>;
interface SelectionQueue {
  latest: symbol;
  tail: Promise<void>;
}

const selections = new WeakMap<QueryClient, SelectionQueue>();

export function selectGlobalDefaultModel(
  client: DefaultModelClient,
  queryClient: QueryClient,
  model: { id: string; provider_id: string },
) {
  const identity = Symbol();
  let queue = selections.get(queryClient);
  if (queue === undefined) {
    queue = { latest: identity, tail: Promise.resolve() };
    selections.set(queryClient, queue);
  }
  queue.latest = identity;
  const owner = queue;
  const isCurrent = () => owner.latest === identity;
  const publish = async (config: KikiConfigResponse) => {
    if (!isCurrent()) return;
    await queryClient.cancelQueries({ queryKey: ['config'] });
    if (!isCurrent()) return;
    queryClient.setQueryData(['config'], config);
    writeSettings({ defaultModel: config.default_model });
  };

  // A tab unmount must not release the write lane: the server can still apply
  // its request. Finish both writes before starting the next human selection.
  const completed = owner.tail.then(async () => {
    if (!isCurrent()) return false;
    try {
      await client.setDefaultModel(model.id);
      // Always carry the provider: the previous selection may have changed it
      // while this tab still displayed the earlier cached configuration.
      await publish(await client.patchConfig({ default_provider: model.provider_id }));
      return isCurrent();
    } catch (error) {
      if (!isCurrent()) return false;
      // A rejected request may have partly landed. Only a fresh server read,
      // still owned by this selection, can reconcile the client after failure.
      try {
        await publish(await client.getConfig());
      } catch {
        if (isCurrent()) await queryClient.invalidateQueries({ queryKey: ['config'] });
      }
      if (!isCurrent()) return false;
      throw error;
    }
  });
  owner.tail = completed.then(() => undefined, () => undefined);
  return { completed, isCurrent };
}
