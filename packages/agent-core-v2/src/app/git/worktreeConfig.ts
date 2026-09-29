import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const WORKTREE_SECTION = 'worktree';

export const worktreeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  root: z.string().refine((root) => root === '' || isAbsolute(root), 'worktree root must be absolute').default(''),
  branchPrefix: z.string().regex(/^[a-z0-9][a-z0-9/-]*\/$/).default('kiki/'),
  defaultBase: z.enum(['head', 'fresh']).default('head'),
  gitTimeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
  cleanup: z.object({
    auto: z.boolean().default(true),
    afterDays: z.number().int().min(1).default(7),
    disposableIgnored: z.array(z.string()).default(['node_modules/', '.turbo/', 'dist/', '.venv/', 'target/']),
  }).default({ auto: true, afterDays: 7, disposableIgnored: ['node_modules/', '.turbo/', 'dist/', '.venv/', 'target/'] }),
});

export type WorktreeConfig = z.infer<typeof worktreeConfigSchema>;
registerConfigSection(WORKTREE_SECTION, worktreeConfigSchema, { defaultValue: worktreeConfigSchema.parse({}) });
