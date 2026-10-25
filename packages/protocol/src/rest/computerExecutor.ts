import { z } from 'zod';

import { WINDOWS_MCP_COMPUTER_CONNECTION } from './config';

export const windowsMcpLicenseSchema = z.object({
  name: z.string().min(1),
  license: z.string().min(1),
}).strict();

export const windowsMcpEnvironmentResponseSchema = z.object({
  id: z.literal('windows-mcp'),
  version: z.literal('0.8.8'),
  commit: z.string().length(40),
  python: z.string().min(1),
  wheelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  wheelBytes: z.number().int().positive(),
  distribution: z.literal('external-environment'),
  managedInstall: z.literal('withheld-until-gpl-acceptance'),
  bundled: z.literal(false),
  autoStart: z.literal(false),
  connection: z.literal(WINDOWS_MCP_COMPUTER_CONNECTION),
  licenses: z.array(windowsMcpLicenseSchema).min(1),
  closureLock: z.string().min(1),
  note: z.string().min(1),
}).strict();
export type WindowsMcpEnvironmentResponse = z.infer<typeof windowsMcpEnvironmentResponseSchema>;

export const windowsMcpRegisterRequestSchema = z.object({
  python: z.string().min(1),
  configPath: z.string().min(1),
  version: z.literal('0.8.8'),
}).strict();
export type WindowsMcpRegisterRequest = z.infer<typeof windowsMcpRegisterRequestSchema>;

export const windowsMcpRegisterResponseSchema = z.object({
  result: z.enum(['mcp-configured', 'existing-mcp-config-reused']),
  name: z.literal(WINDOWS_MCP_COMPUTER_CONNECTION),
  connection: z.literal(WINDOWS_MCP_COMPUTER_CONNECTION),
  started: z.literal(false),
  bundled: z.literal(false),
}).strict();
export type WindowsMcpRegisterResponse = z.infer<typeof windowsMcpRegisterResponseSchema>;
