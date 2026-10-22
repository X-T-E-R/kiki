import { z } from 'zod';

export const ProviderTargetsSchema = z.array(z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}, 'Use an HTTP(S) API base URL without credentials, query, or fragment')).min(1);
const minBytes = z.number().int().nonnegative().safe().optional();

export const RequestCompressionSchema = z.discriminatedUnion('encoding', [
  z.object({ encoding: z.literal('off') }).strict(),
  z.object({ encoding: z.literal('gzip'), targets: ProviderTargetsSchema, minBytes }).strict(),
  z.object({ encoding: z.literal('zstd'), targets: ProviderTargetsSchema, minBytes, dictionary: z.boolean().optional() }).strict(),
]);
