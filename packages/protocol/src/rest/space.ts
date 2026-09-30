import { z } from 'zod';

export const removeSpaceConfigOverrideRequestSchema = z.object({
  domain: z.string().min(1),
  key_path: z.array(z.string().min(1)),
}).strict();
export type RemoveSpaceConfigOverrideRequest = z.infer<typeof removeSpaceConfigOverrideRequestSchema>;

/**
 * Space identity, the one definition both sides validate against: the REST
 * record below and `home.toml` (`agent-core-v2/app/bootstrap/spaceHome`), which
 * reads the same fields off the file a space home is configured by.
 */
export const SPACE_ID_PATTERN = /^h-[a-z0-9-]+$/;
export const SPACE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const spaceIdSchema = z.string().regex(SPACE_ID_PATTERN);
export const spaceNameSchema = z.string().trim().min(1);
export const spaceColorSchema = z.string().regex(SPACE_COLOR_PATTERN);

export const spaceRecordSchema = z.object({
  id: spaceIdSchema,
  name: spaceNameSchema,
  color: spaceColorSchema.optional(),
  path: z.string().min(1),
  lastOpenedAt: z.string().optional(),
});
export type SpaceRecord = z.infer<typeof spaceRecordSchema>;
export const spacesResponseSchema = z.object({ items: z.array(spaceRecordSchema.extend({ id: z.union([z.literal('main'), spaceRecordSchema.shape.id]), primary: z.boolean(), credentials_shared: z.boolean().optional() })) });
export type ListSpacesResponse = z.infer<typeof spacesResponseSchema>;

export const createSpaceRequestSchema = z.object({
  name: spaceRecordSchema.shape.name,
  color: spaceRecordSchema.shape.color,
  path: spaceRecordSchema.shape.path,
  inherit: z.object({
    config: z.boolean().optional(),
    credentials: z.enum(['shared', 'isolated']).optional(),
    agents: z.boolean().optional(),
    instructions: z.union([z.boolean(), z.literal('stack')]).optional(),
    skills: z.boolean().optional(),
    mcp: z.boolean().optional(),
    appearance: z.boolean().optional(),
    plugins: z.boolean().optional(),
    generic_roots: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type CreateSpaceRequest = z.infer<typeof createSpaceRequestSchema>;
export const attachSpaceRequestSchema = z.object({ path: spaceRecordSchema.shape.path }).strict();
export type AttachSpaceRequest = z.infer<typeof attachSpaceRequestSchema>;
export const spaceIdParamsSchema = z.object({ id: spaceRecordSchema.shape.id });
export const sshCopyTargetSchema = z.object({
  hostId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
}).strict();
export const sshCopyCandidatesResponseSchema = z.object({
  hosts: z.array(sshCopyTargetSchema.extend({ name: z.string(), credential_kinds: z.array(z.enum(['password', 'passphrase'])) })),
});
export type SshCopyCandidatesResponse = z.infer<typeof sshCopyCandidatesResponseSchema>;
export const updateSpaceRequestSchema = z.object({
  inherit: z.object({ credentials: z.enum(['shared', 'isolated']) }).strict(),
  copy_ssh_credentials: z.union([z.boolean(), z.object({ hosts: z.array(sshCopyTargetSchema).max(64) }).strict()]).optional(),
}).strict();
export type UpdateSpaceRequest = z.infer<typeof updateSpaceRequestSchema>;
export const updateSpaceResponseSchema = z.object({
  space: spaceRecordSchema.extend({ credentials_shared: z.boolean() }),
  restart_required: z.boolean(),
  copied_ssh_entries: z.number().int().min(0),
  retained_isolated_ssh_entries: z.number().int().min(0).optional(),
});
export type UpdateSpaceResponse = z.infer<typeof updateSpaceResponseSchema>;
export const deleteSpaceParamsSchema = z.object({ tail: z.string().min(1) });
export const deleteSpaceRequestSchema = z.object({ confirm_name: spaceRecordSchema.shape.name }).strict();
export type DeleteSpaceRequest = z.infer<typeof deleteSpaceRequestSchema>;
