import { describe, expect, it } from 'vitest';
import { parseAgentFileText } from '@kiki/agent-profiles';
import { modelCognitionSchema, modelPromptOverridesSchema } from '@kiki/protocol';
import {
  changePromptBranch, cognitionBody, cognitionDraft, cognitionProblem,
  modelPromptBody, modelPromptDraft, modelPromptProblem,
  promptIdentityBody, promptIdentityDraft, promptIdentityProblem,
  promptOverridesBody, promptOverridesDraft, promptOverridesProblem,
} from './promptIdentityDraft';

const clean = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('prompt identity drafts', () => {
  it('keeps legacy common content shared without writing branches', () => {
    const source = { overlay: 'cognition/common.md', steering: ['cognition/first.md', 'cognition/second.md'] };
    const draft = promptIdentityDraft(source, cognitionDraft);
    expect(draft.main.mode).toBe('same');
    expect(draft.independent.mode).toBe('same');
    expect(clean(promptIdentityBody(draft, cognitionBody))).toEqual(source);
  });

  it('creates a separate main group without copying steering or anchor', () => {
    const draft = changePromptBranch(promptIdentityDraft({ overlay: 'common.md', steering: 'reminder.md', anchor: 'anchor.md', anchor_steps: 4 }, cognitionDraft), 'main', 'custom');
    draft.main.content.overlay = 'main.md';
    expect(clean(promptIdentityBody(draft, cognitionBody))).toEqual({ overlay: 'common.md', steering: 'reminder.md', anchor: 'anchor.md', anchor_steps: 4, main: { overlay: 'main.md' } });
    expect(draft.independent.mode).toBe('same');
    expect(promptIdentityProblem(draft, cognitionBody, cognitionProblem)).toBeUndefined();
  });

  it('supports main-only content and restores common by deleting the branch', () => {
    const draft = promptIdentityDraft({ main: { overlay: 'main.md' }, independent: 'off' }, cognitionDraft);
    expect(clean(promptIdentityBody(draft, cognitionBody))).toEqual({ main: { overlay: 'main.md' }, independent: 'off' });
    expect(clean(promptIdentityBody(changePromptBranch(draft, 'main', 'same'), cognitionBody))).toEqual({ independent: 'off' });
  });

  it('preserves explicit same until the user changes that choice', () => {
    const draft = promptIdentityDraft({ fields: { 'system.shared': '' }, main: 'same' }, promptOverridesDraft);
    expect(clean(promptIdentityBody(draft, promptOverridesBody))).toEqual({ fields: { 'system.shared': '' }, main: 'same' });
    expect(promptIdentityProblem(draft, promptOverridesBody, promptOverridesProblem)).toBeUndefined();
    draft.common.fields = [];
    expect(promptIdentityProblem(draft, promptOverridesBody, promptOverridesProblem)).toBe('missingCommon');
  });

  it.each([
    'prompt_overrides:\n  main: same',
    'model_profiles:\n  - alias: fixture/model-a\n    main: same',
  ])('rejects same without common in the real agent-file loader: %s', (declaration) => {
    expect(() => parseAgentFileText({ path: '/fixture/agents/helper.md', source: 'project',
      text: `---\nname: helper\ndescription: Example helper\n${declaration}\n---\nHelp with the task.`,
    })).toThrow(/same|common/);
  });

  it('clears only the explicit branch while retaining the schema guard and sibling choice', () => {
    expect(modelPromptOverridesSchema.safeParse({ main: 'same' }).success).toBe(false);
    expect(modelCognitionSchema.safeParse({ main: 'same' }).success).toBe(false);
    const invalid = promptIdentityDraft({ main: 'same', independent: 'off' }, promptOverridesDraft);
    expect(promptIdentityProblem(invalid, promptOverridesBody, promptOverridesProblem)).toBe('missingCommon');
    const restored = changePromptBranch(invalid, 'main', 'same');
    expect(clean(promptIdentityBody(restored, promptOverridesBody))).toEqual({ independent: 'off' });
    expect(promptIdentityProblem(restored, promptOverridesBody, promptOverridesProblem)).toBeUndefined();
    expect(modelPromptOverridesSchema.safeParse(promptIdentityBody(restored, promptOverridesBody)).success).toBe(true);
    expect(invalid.main.explicitSame).toBe(true);
  });

  it('rejects empty separate groups, duplicate fields and invalid anchor steps', () => {
    const empty = changePromptBranch(promptIdentityDraft(undefined, promptOverridesDraft), 'main', 'custom');
    expect(promptIdentityProblem(empty, promptOverridesBody, promptOverridesProblem)).toBe('emptyBranch');
    empty.main.content.fields = [{ id: '1', name: 'system.shared', value: 'first' }, { id: '2', name: 'system.shared', value: 'second' }];
    expect(promptIdentityProblem(empty, promptOverridesBody, promptOverridesProblem)).toBe('duplicateField');
    expect(cognitionProblem({ ...cognitionDraft(undefined), anchorSteps: '0' })).toBe('anchorSteps');
  });

  it('keeps the model body branch separate from field overrides and validates the pair', () => {
    const draft = promptIdentityDraft({ prompt_mode: 'append', prompt: 'Shared', main: { prompt_mode: 'prepend', prompt: 'Main' }, prompt_overrides: { main: 'off' } }, modelPromptDraft);
    expect(clean(promptIdentityBody(draft, modelPromptBody))).toEqual({ prompt_mode: 'append', prompt: 'Shared', main: { prompt_mode: 'prepend', prompt: 'Main' } });
    draft.main.content.mode = '';
    expect(promptIdentityProblem(draft, modelPromptBody, modelPromptProblem)).toBe('promptPair');
  });
});
