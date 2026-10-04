/**
 * settings-hooks — the Hooks settings leaf with a full schemaVersion-2
 * config: inject and observe rules (one disabled), a cadence, match
 * conditions, rule files, disabled ids and a legacy command rule. Nested
 * hooks keys stay camelCase: the fixture server stores hooks as an opaque
 * value, exactly like the wire shape GET /config returns.
 */

import settings from './settings.scenario.mjs';

export default {
  ...settings,
  config: {
    ...settings.config,
    hooks: {
      schemaVersion: 2,
      enabled: true,
      disabled: ['user/weekly-review'],
      files: ['hooks/team-guidance.toml'],
      rules: [
        {
          id: 'focus-reminder',
          event: 'step.before',
          priority: 100,
          enabled: true,
          match: { models: ['kimi-k2.8'], tools: ['Write', 'Edit'] },
          cadence: { everyCompletedSteps: 8, counterScope: 'agent', partitionBy: 'model' },
          action: { type: 'inject', text: 'Before editing, restate the current sub-goal in one line.' },
        },
        {
          id: 'commit-style',
          event: 'prompt.submit',
          priority: 120,
          enabled: true,
          match: {},
          action: { type: 'inject', textFile: 'hooks/commit-style.md' },
        },
        {
          id: 'tool-usage-log',
          event: 'tool.after',
          priority: 100,
          enabled: false,
          match: { statuses: ['error'] },
          action: { type: 'observe' },
        },
      ],
      legacy: [
        { event: 'SessionStart', command: 'echo session-started >> ~/.kiki/hooks.log', timeout: 10 },
      ],
    },
  },
};
