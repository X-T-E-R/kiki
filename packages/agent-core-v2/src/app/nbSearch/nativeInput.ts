import { searchInputSchema, fetchInputSchema, type SearchInput, type SearchRunInput, type FetchInput } from '@nb-corp/nb-search';

export const NativeSearchInputSchema: typeof searchInputSchema = searchInputSchema;
export const NativeFetchInputSchema: typeof fetchInputSchema = fetchInputSchema;
export type NativeSearchInput = SearchInput | (Omit<SearchRunInput, 'action'> & { action?: 'run' });
export type NativeFetchInput = FetchInput;

type ParameterSchema = Record<string, unknown>;

function objectBranches(schema: ParameterSchema): ParameterSchema[] {
  const branches = schema['anyOf'] ?? schema['oneOf'];
  return Array.isArray(branches) ? branches.flatMap((branch: ParameterSchema) => objectBranches(branch)) : [schema];
}

function toolParameters(schema: ParameterSchema): ParameterSchema {
  const alternatives = new Map<string, ParameterSchema[]>();
  for (const branch of objectBranches(schema)) {
    for (const [name, property] of Object.entries(branch['properties'] as Record<string, ParameterSchema>)) {
      const variants = alternatives.get(name) ?? [];
      if (!variants.some((candidate) => JSON.stringify(candidate) === JSON.stringify(property))) variants.push(property);
      alternatives.set(name, variants);
    }
  }
  const properties = Object.fromEntries([...alternatives].map(([name, variants]) => [name,
    variants.length === 1 ? variants[0] : variants.every((variant) => typeof variant['const'] === 'string')
      ? { type: 'string', enum: variants.map((variant) => variant['const']) }
      : { anyOf: variants },
  ]));
  return { type: 'object', properties, additionalProperties: false };
}

export function nativeSearchParameters(): Record<string, unknown> {
  return toolParameters(searchInputSchema.toJSONSchema({ target: 'draft-7', io: 'input' }));
}

export function nativeFetchParameters(): Record<string, unknown> {
  return toolParameters(fetchInputSchema.toJSONSchema({ target: 'draft-7', io: 'input' }));
}

export function parseNativeSearchInput(input: NativeSearchInput): SearchInput {
  return searchInputSchema.parse({ ...input, action: input.action === undefined ? 'run' : input.action });
}

export function parseNativeFetchInput(input: NativeFetchInput) {
  return fetchInputSchema.parse(input);
}
