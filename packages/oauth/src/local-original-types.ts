import { z } from 'zod';

export const LocalOriginalOAuthProviderSchema = z.enum(['openai-codex', 'grok-build', 'kimi-code']);
export type LocalOriginalOAuthProvider = z.infer<typeof LocalOriginalOAuthProviderSchema>;

export const LocalOriginalOAuthBackendSchema = z.enum(['file', 'keyring', 'encrypted']);
export type LocalOriginalOAuthBackend = z.infer<typeof LocalOriginalOAuthBackendSchema>;

export const LocalOriginalOAuthSourceRefSchema = z.object({
  kind: z.literal('local_original'),
  provider: LocalOriginalOAuthProviderSchema,
  homeDir: z.string().min(1),
  storageBackend: LocalOriginalOAuthBackendSchema,
  authFile: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
}).strict().superRefine((source, ctx) => {
  if (source.provider !== 'kimi-code' && source.accountId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'An original account identity is required.' });
  }
  if (source.provider === 'kimi-code' && (source.storageBackend === 'encrypted' || source.accountId !== undefined || source.userId !== undefined || source.scope !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Kimi Code sources select a credential slot, not an account identity.' });
  }
});
export type LocalOriginalOAuthSourceRef = z.infer<typeof LocalOriginalOAuthSourceRefSchema>;

export type LocalOriginalOAuthState =
  | 'ready'
  | 'refresh_required'
  | 'signed_out'
  | 'unreadable'
  | 'unsupported'
  | 'account_changed'
  | 'refresh_failed';

export interface LocalOriginalOAuthProbe {
  readonly provider: LocalOriginalOAuthProvider;
  readonly homeDir: string;
  readonly storageBackend: LocalOriginalOAuthBackend | 'ephemeral' | null;
  readonly state: LocalOriginalOAuthState;
  readonly account: { readonly state: 'known'; readonly id: string } | { readonly state: 'unknown' };
  readonly canConnect: boolean;
  readonly reason?: string;
  readonly sourceRef?: LocalOriginalOAuthSourceRef;
}

export interface OriginalOAuthKeyring {
  load(service: string, account: string): Promise<string | undefined>;
  save(service: string, account: string, value: string): Promise<void>;
}

export interface OriginalOAuthNative {
  canonicalizeOriginalHome(homeDir: string): Promise<string>;
  ageEncrypt(plaintext: Uint8Array, passphrase: string): Promise<Uint8Array>;
  ageDecrypt(ciphertext: Uint8Array, passphrase: string): Promise<Uint8Array>;
  acquireGrokAuthLock(
    authJsonPath: string,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<{ release(): void; isCurrent(): boolean }>;
}
