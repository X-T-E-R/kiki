/**
 * Recipe queries for the settings surfaces.
 *
 * One cache namespace, so a write that lands anywhere — a model row, the
 * drawer, the market tab — re-reads the same lists the others render from.
 * Reads stay query-driven rather than hand-copied into component state: the
 * installed list, a package's detail and the market catalog are the truth the
 * drawer shows, and a stale copy of any of them would misreport what runs.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useConnection } from '../state/connection';

export const RECIPE_LIST_KEY = ['recipes'] as const;
export const RECIPE_MARKETS_KEY = ['recipe-markets'] as const;
const recipeDetailKey = (installationId: string) => ['recipe', installationId] as const;

/**
 * A server that predates the Recipe surface reports the missing namespace
 * instead of an empty list. An empty list would read as "you have no
 * Recipes", which is a different and wrong answer.
 */
function isMissingSurface(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'METHOD_NOT_FOUND' || code === '40401'
    || /recipeService|recipes? (facade|namespace)/iu.test(message);
}

/** Installed Recipes. Unavailable surface resolves to `null`, not `[]`. */
export function useRecipeList() {
  const { client } = useConnection();
  return useQuery({
    queryKey: RECIPE_LIST_KEY,
    queryFn: () => client.listRecipes(),
    retry: false,
  });
}

/** One installed package, including its resolved branches and files. */
export function useRecipeDetail(installationId: string | null) {
  const { client } = useConnection();
  return useQuery({
    queryKey: recipeDetailKey(installationId ?? ''),
    queryFn: () => client.getRecipe(installationId ?? ''),
    enabled: installationId !== null && installationId !== '',
    retry: false,
  });
}

/** Configured markets with their cached catalogs and offline state. */
export function useRecipeMarkets() {
  const { client } = useConnection();
  return useQuery({
    queryKey: RECIPE_MARKETS_KEY,
    queryFn: () => client.listRecipeMarkets(),
    retry: false,
  });
}

/**
 * One mutation wrapper for every Recipe write.
 *
 * Installing, updating, forking, saving and removing all change the same two
 * facts — what is installed and, through the model row that called it, what a
 * model is bound to — so they invalidate the same keys instead of each caller
 * remembering its own.
 */
export function useRecipeMutation<TInput, TOutput>(
  action: (input: TInput) => Promise<TOutput>,
  options: {
    /** Re-read the model entity too: a bind or a conflict changes it. */
    readonly alsoModelId?: string;
    readonly onSuccess?: (result: TOutput, input: TInput) => void;
    readonly onError?: (error: unknown) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TOutput, unknown, TInput>({
    mutationFn: (input: TInput) => action(input),
    onSuccess: async (result: TOutput, input: TInput) => {
      await queryClient.invalidateQueries({ queryKey: RECIPE_LIST_KEY });
      await queryClient.invalidateQueries({ queryKey: RECIPE_MARKETS_KEY });
      if (options.alsoModelId !== undefined) {
        await queryClient.invalidateQueries({ queryKey: ['model-entity', options.alsoModelId] });
        await queryClient.invalidateQueries({ queryKey: ['models'] });
      }
      options.onSuccess?.(result, input);
    },
    onError: (error: unknown) => { options.onError?.(error); },
  });
}

export { isMissingSurface };
