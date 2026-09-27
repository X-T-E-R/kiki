import { describe, expect, it } from 'vitest';

import {
  modelGenerationMigrationApplyRequestSchema,
  modelGenerationMigrationPreviewSchema,
  modelGenerationMigrationRestoreRequestSchema,
} from '../rest/modelGenerationMigration';

const revision = 'f'.repeat(64);

describe('model generation migration REST contract', () => {
  it('exposes only revision, field names, reason codes and backup identifiers', () => {
    const preview = {
      revision,
      changes: [{ model_id: 'model', fields: ['temperature'] }],
      needs_review: [{ model_id: 'model', code: 'differs', field: 'top_p' }],
      backups: ['config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000'],
    };
    expect(modelGenerationMigrationPreviewSchema.parse(preview)).toEqual(preview);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, backups: [{ backup_key: preview.backups[0], secret: 'sk-secret' }] }).success).toBe(false);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, original_text: 'sk-secret' }).success).toBe(false);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, needs_review: [{ model_id: 'model', reason: 'raw' }] }).success).toBe(false);
  });

  it('requires a revision and affirmative confirmation on both write endpoints', () => {
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision }).success).toBe(false);
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision, confirmed: false }).success).toBe(false);
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision, confirmed: true }).success).toBe(true);
    expect(modelGenerationMigrationRestoreRequestSchema.safeParse({ backup_key: 'backup', confirmed: true }).success).toBe(false);
    expect(modelGenerationMigrationRestoreRequestSchema.safeParse({ revision, backup_key: 'backup', confirmed: true }).success).toBe(true);
  });
});
