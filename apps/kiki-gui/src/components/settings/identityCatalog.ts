import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useConnection } from '../../state/connection';

export const REQUEST_IDENTITY_QUERY_KEY = ['request-identity'] as const;

/** Custom identities for the layer pickers; empty until the catalog loads. */
export function useCustomIdentityChoices(): readonly { id: string; label: string }[] {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: REQUEST_IDENTITY_QUERY_KEY,
    queryFn: () => client.requestIdentity.get(),
    staleTime: 30_000,
  });
  return useMemo(
    () => (query.data?.profiles ?? []).filter((profile) => !profile.builtin).map(({ id, label }) => ({ id, label })),
    [query.data],
  );
}
