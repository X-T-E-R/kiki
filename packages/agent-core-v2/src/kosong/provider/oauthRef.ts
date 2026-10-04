import { LocalOriginalOAuthSourceRefSchema } from '@kiki/oauth/local-original-types';
import { z } from 'zod';

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
  source: LocalOriginalOAuthSourceRefSchema.optional(),
});
