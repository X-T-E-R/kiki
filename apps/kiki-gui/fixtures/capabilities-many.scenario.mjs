/**
 * capabilities-many — the capabilities scenario with a workspace that sees
 * 80 skills across every source (plugin, project, user, extra folders,
 * built-in), so the Skills view is proven at the size people actually reach:
 * folded groups, "Show all", search narrowing, and long descriptions.
 */

import base from './capabilities.scenario.mjs';

const WSID = 'wd_fixture_000000000000';

const VERBS = ['Draft', 'Review', 'Summarize', 'Audit', 'Refactor', 'Explain', 'Plan', 'Triage', 'Document', 'Benchmark'];
const NOUNS = ['release notes', 'pull requests', 'incident reports', 'API changes', 'test failures', 'onboarding docs', 'SQL queries', 'design specs'];

function skill(index, source, pathOf, extra = {}) {
  const verb = VERBS[index % VERBS.length];
  const noun = NOUNS[Math.floor(index / VERBS.length) % NOUNS.length];
  const name = `${verb.toLowerCase()}-${noun.replaceAll(' ', '-').toLowerCase()}${index >= 80 ? `-${index}` : ''}`;
  return {
    name,
    description: `${verb} ${noun} with the team's conventions, and flag anything that needs a human decision before it ships.`,
    path: pathOf(name),
    source,
    ...extra,
  };
}

const layout = [
  ['plugin', 14, (name) => `C:/Users/fixture/.kiki/plugins/managed/research/skills/${name}/SKILL.md`],
  ['project', 28, (name) => `C:/fixture/.kimi/skills/${name}/SKILL.md`],
  ['user', 18, (name) => `C:/Users/fixture/.kimi/skills/${name}/SKILL.md`],
  ['extra', 10, (name) => `C:/fixture/shared/${name}/SKILL.md`],
  ['builtin', 10, (name) => `builtin:${name}`],
];

const skills = [];
let index = 0;
for (const [source, count, pathOf] of layout) {
  for (let offset = 0; offset < count; offset += 1) {
    skills.push(skill(index, source, pathOf, {
      prompt_command: index % 7 === 0 ? true : undefined,
      argument_hint: index % 14 === 0 ? '[path]' : undefined,
      disable_model_invocation: index % 11 === 5 ? true : undefined,
    }));
    index += 1;
  }
}

export default {
  ...base,
  workspaceSkills: { [WSID]: skills },
};
