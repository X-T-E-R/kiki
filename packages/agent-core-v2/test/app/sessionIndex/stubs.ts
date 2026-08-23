import {
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';

export function stubSessionIndexMirror(): ISessionIndexMirror & {
  readonly recorded: SessionSummary[];
} {
  const recorded: SessionSummary[] = [];
  let mutationEpoch = 0;
  const invalidate = (id: string): void => {
    mutationEpoch += 1;
    for (let index = recorded.length - 1; index >= 0; index--) {
      if (recorded[index]?.id === id) recorded.splice(index, 1);
    }
  };
  return {
    _serviceBrand: undefined,
    recorded,
    record: (summary) => {
      mutationEpoch += 1;
      recorded.push(summary);
    },
    epoch: () => mutationEpoch,
    dirtyEpoch: () => undefined,
    settleDirty: () => {},
    invalidate,
    pending: () => recorded,
    acknowledge: (summaries) => {
      for (const summary of summaries) {
        const index = recorded.findIndex((record) => record === summary);
        if (index !== -1) recorded.splice(index, 1);
      }
    },
    runExclusive: (operation) => operation(),
    evict: async (id) => {
      invalidate(id);
    },
    drain: async () => {},
  };
}
