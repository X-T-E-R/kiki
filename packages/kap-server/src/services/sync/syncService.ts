import { join } from 'node:path';
import {
  type EncryptedCredentialEnvelope,
  type ProjectIdentity,
  type SkillRootSyncPlan,
} from '@kiki/protocol';
import {
  ConfigTarget,
  CREDENTIALS_POOL_SECTION,
  extractPortableConfigLayer,
  loadNativeAgeX25519Cipher,
  mergeCredentialEnvelopes,
  planSkillSync,
  projectRoots,
  resolveProjectIdentity,
  sealSyncedCredentialPool,
  userRoots,
  type AgeX25519Cipher,
  type AgeX25519Keypair,
  type CredentialEnvelopeMergeResult,
  type CredentialsPoolSection,
  type IConfigRegistry,
  type IConfigService,
  type IMemoryScopes,
} from '@kiki/agent-core-v2';

import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

export interface SyncServiceOptions {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly configService?: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'>;
  readonly configRegistry?: Pick<IConfigRegistry, 'getSection' | 'listSections'>;
  readonly memoryScopes?: Pick<IMemoryScopes, 'bindWorkspace' | 'listProjectBindings'>;
  readonly cipher?: AgeX25519Cipher;
}

/** Coordinates device X25519 keys, per-entry credential envelopes, portable project identities, portable config export, and git-aware skill sync plans. */
export class SyncService {
  private readonly keyPath: string;
  private readonly cipher: AgeX25519Cipher;
  private cachedKeypair: AgeX25519Keypair | undefined;
  private keyLoadFlight: Promise<AgeX25519Keypair> | undefined;

  constructor(private readonly options: SyncServiceOptions) {
    this.keyPath = join(options.homeDir, 'credentials', 'device-x25519.key');
    this.cipher = options.cipher ?? loadNativeAgeX25519Cipher();
  }

  peekDeviceRecipient(): string | undefined {
    return this.cachedKeypair?.recipient;
  }

  async ensureDeviceKeypair(): Promise<AgeX25519Keypair> {
    if (this.cachedKeypair !== undefined) return this.cachedKeypair;
    if (this.keyLoadFlight !== undefined) return this.keyLoadFlight;
    this.keyLoadFlight = (async () => {
      try {
        const raw = (await readPrivateFile(this.keyPath)).toString('utf8').trim();
        if (raw.startsWith('AGE-SECRET-KEY-1')) {
          const recipient = this.cipher.recipientFromIdentity(raw);
          this.cachedKeypair = { identity: raw, recipient };
          return this.cachedKeypair;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const generated = this.cipher.generateX25519Keypair();
      await writePrivateFile(this.keyPath, `${generated.identity}\n`);
      this.cachedKeypair = generated;
      return generated;
    })();
    try {
      return await this.keyLoadFlight;
    } finally {
      this.keyLoadFlight = undefined;
    }
  }

  async getDevicePublicKey(): Promise<{ readonly recipient: string }> {
    const keypair = await this.ensureDeviceKeypair();
    return { recipient: keypair.recipient };
  }

  async sealSyncedCredentials(input: {
    readonly recipients: readonly string[];
    readonly credentialIds?: readonly string[];
  }): Promise<{
    readonly envelopes: readonly EncryptedCredentialEnvelope[];
    readonly skipped: readonly { readonly credentialId: string; readonly reason: string }[];
  }> {
    const pool = await this.readCredentialPool();
    return sealSyncedCredentialPool(pool, input.recipients, {
      credentialIds: input.credentialIds,
      cipher: this.cipher,
    });
  }

  async mergeIncomingCredentials(
    envelopes: readonly EncryptedCredentialEnvelope[],
  ): Promise<CredentialEnvelopeMergeResult> {
    const keypair = await this.ensureDeviceKeypair();
    const localPool = await this.readCredentialPool();
    const result = mergeCredentialEnvelopes(localPool, envelopes, keypair.identity, this.cipher);
    if (result.applied.length > 0 && this.options.configService !== undefined) {
      await this.options.configService.ready;
      await this.options.configService.replace(CREDENTIALS_POOL_SECTION, result.merged, ConfigTarget.User);
    }
    return result;
  }

  async resolveProjectIdentity(cwd: string, bind = true): Promise<ProjectIdentity> {
    if (bind && this.options.memoryScopes?.bindWorkspace !== undefined) {
      return this.options.memoryScopes.bindWorkspace(cwd);
    }
    return resolveProjectIdentity(cwd);
  }

  async exportPortableConfig(): Promise<Record<string, unknown>> {
    if (this.options.configService === undefined) return {};
    await this.options.configService.ready;
    const rawUser: Record<string, unknown> = {};
    const domains = new Set<string>([
      'defaultModel',
      'defaultProvider',
      ...(this.options.configRegistry?.listSections().map((section) => section.domain) ?? []),
    ]);
    for (const domain of domains) {
      const value = this.options.configService.inspect(domain).userValue;
      if (value !== undefined) rawUser[domain] = value;
    }
    return extractPortableConfigLayer(rawUser, this.options.configRegistry);
  }

  async planSkillsSync(workDir?: string): Promise<readonly SkillRootSyncPlan[]> {
    const roots = [
      ...(await userRoots(this.options.homeDir, this.options.osHomeDir)),
      ...(workDir === undefined ? [] : await projectRoots(workDir)),
    ];
    return planSkillSync(roots);
  }

  private async readCredentialPool(): Promise<CredentialsPoolSection> {
    if (this.options.configService === undefined) return {};
    await this.options.configService.ready;
    return this.options.configService.get<CredentialsPoolSection>(CREDENTIALS_POOL_SECTION) ?? {};
  }
}
