import { z } from 'zod';

export const BoardStorageConfigSchema = z.strictObject({
  mode: z.enum(['auto', 'global', 'fixed']),
  path: z.string().trim().max(4096).refine((value) => !/[\u0000-\u001f]/u.test(value), 'Storage path contains control characters.').optional(),
}).refine((value) => value.mode !== 'fixed' || !!value.path, { message: 'Fixed storage requires a path.', path: ['path'] });
export const TaskBoardConfigSchema = z.strictObject({ storage: BoardStorageConfigSchema.default({ mode: 'auto' }) });
export type BoardStorageConfig = z.infer<typeof BoardStorageConfigSchema>;
export type TaskBoardConfig = z.infer<typeof TaskBoardConfigSchema>;
