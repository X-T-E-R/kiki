import type { IMemoryAuthorityService } from '#/app/memory/memoryAuthorityStore';

export function stubMemoryStartup(): Pick<IMemoryAuthorityService, 'prepare'> {
  return {
    prepare: async () => ({ version: 1, epoch: 1, backend: 'sqlite', mode: 'active', migrationId: '00000000-0000-4000-8000-000000000000' }),
  };
}
