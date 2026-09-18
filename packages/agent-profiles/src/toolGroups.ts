import { z } from 'zod';

export const TOOL_GROUP_IDS = [
  'agent',
  'board',
  'cron',
  'fsRead',
  'fsWrite',
  'goal',
  'plan',
  'question',
  'shell',
  'skill',
  'task',
  'thread',
  'toolSelect',
  'web',
] as const;

export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

export const TOOL_GROUP_ID_SCHEMA = z.enum(TOOL_GROUP_IDS);

export function isToolGroupId(value: string): value is ToolGroupId {
  return (TOOL_GROUP_IDS as readonly string[]).includes(value);
}
