import { describe, expect, it } from 'vitest';

import { activateSkillRequestSchema } from '../rest/skill';

describe('activate skill request contract', () => {
  it('retains an explicit child target with the existing activation payload', () => {
    const input = {
      agent_id: 'child-1',
      prompt_id: 'skill-1',
      after_model_switch: 'switch-1',
      args: '--fix',
      user_input: '/review --fix',
      attachments: [
        {
          type: 'file' as const,
          file_id: 'file-1',
          name: 'notes.txt',
          media_type: 'text/plain',
          size: 5,
        },
      ],
    };
    expect(activateSkillRequestSchema.parse(input)).toEqual(input);
  });

  it('accepts omitted and explicit main targets as distinct wire inputs', () => {
    expect(activateSkillRequestSchema.parse({})).toEqual({});
    expect(activateSkillRequestSchema.parse({ agent_id: 'main' })).toEqual({ agent_id: 'main' });
  });

  it('rejects empty target and dependency ids instead of silently dropping them', () => {
    expect(activateSkillRequestSchema.safeParse({ agent_id: '' }).success).toBe(false);
    expect(activateSkillRequestSchema.safeParse({ after_model_switch: '' }).success).toBe(false);
  });
});
