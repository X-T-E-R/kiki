/**
 * profile-editor — the Agents team view and profile editor against a team
 * shaped like a real operator setup: a main lead with a lease table, role
 * subagents pinned to different models, model candidates with `when`
 * conditions, one pin whose alias the catalog lacks, one same-name file that
 * loses discovery, an edited built-in copy, and an external-engine profile.
 *
 * `executor_fields`, `shadowed_files`, `spawn_constraints` and `executors`
 * mirror what kap-server projects; the values here are mock data.
 */

const WSID = 'wd_fixture_000000000000';
const HOME = 'C:/fixture/home/agents';

const LEAD_PROMPT = [
  'You are the lead for this workspace. You frame the problem, pick the owner, and accept the result.',
  '',
  '## Delegation',
  '- Keep simple, serial work inline. Delegate when a specialist adds evidence or parallel progress.',
  '- One active owner per node. Do not redo a delegated node.',
  '- Name the exact paths and commands you already know when you brief a subagent.',
  '',
  '## Acceptance',
  '- Review at the candidate boundary, not after every edit.',
  '- Reconcile returned conclusions with the user intent before reporting.',
  '',
  '## Models',
  '- Think runs on astra only; no other role may use it.',
  '- Explore defaults to the flash model; do not copy the caller model into it.',
].join('\n');

const IMPLEMENTER_PROMPT = [
  'You are the implementer. Own the engineering objective end to end: read, change, verify, report.',
  '',
  '1. Read the code around the change before writing.',
  '2. Make the smallest coherent change; no unrelated refactors.',
  '3. Run the project checks that cover the change.',
  '4. Report files changed, checks run, and anything left open.',
].join('\n');

const profile = (name, fields) => ({
  name, source: 'user', workspace_id: WSID, source_file: `${HOME}/${name}.md`, main: false, disabled: false,
  subagent_policy: 'advisory', routes: [], ...fields,
});

const frontmatter = (lines) => `---\n${lines.join('\n')}\n---\n\n`;

export default {
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/k3',
    providers: { fixture: { type: 'anthropic', has_api_key: true } },
  },
  models: [
    { provider: 'fixture', model: 'fixture/k3', display_name: 'K3', max_context_size: 262_144, support_efforts: ['low', 'high', 'max'], default_effort: 'high' },
    { provider: 'fixture', model: 'fixture/sol', display_name: 'Sol', max_context_size: 1_000_000, support_efforts: ['medium', 'high', 'xhigh', 'max'], default_effort: 'high' },
    { provider: 'fixture', model: 'fixture/astra', display_name: 'Astra', max_context_size: 1_000_000, support_efforts: ['high', 'xhigh'], default_effort: 'xhigh' },
    { provider: 'fixture', model: 'fixture/flash', display_name: 'Flash', max_context_size: 128_000, support_efforts: ['high', 'max'], default_effort: 'max' },
    { provider: 'fixture', model: 'fixture/m3', display_name: 'M3', max_context_size: 200_000, support_efforts: ['high', 'max'] },
  ],
  providers: [
    { id: 'fixture', type: 'anthropic', has_api_key: true, status: 'connected', models: ['fixture/k3', 'fixture/sol', 'fixture/astra', 'fixture/flash', 'fixture/m3'] },
  ],
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 3, pinned: false },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in assistant.', main: true, disabled: false, routes: [], subagents: ['explore', 'general'] },
    { name: 'explore', source: 'builtin', description: 'Read-only codebase exploration agent.', main: false, disabled: false, routes: [], prompt: 'Find the facts the caller asked for and cite where they are.', pinned_model_alias: 'fixture/flash', thinking_effort: 'max', subagents: [] },
    profile('lead', {
      main: true, description: 'Workspace lead: frames, delegates, accepts.', when_to_use: 'Open a new session for multi-step engineering work.',
      prompt: LEAD_PROMPT, pinned_model_alias: 'fixture/k3', thinking_effort: 'max', auto_compact: 200_000,
      subagents: [
        'explore',
        { name: 'implementer', model_alias: 'fixture/sol', thinking_effort: 'max' },
        'think',
        { name: 'reviewer', thinking_effort: 'high' },
        'writer',
      ],
    }),
    profile('implementer', {
      description: 'Owns an engineering objective end to end.', when_to_use: 'A scoped change that needs reading, editing and verification.',
      prompt: IMPLEMENTER_PROMPT, pinned_model_alias: 'fixture/sol', thinking_effort: 'max', subagents: ['explore'],
      // A second implementer.md in the same folder lost first-wins discovery.
      shadowed_files: [`${HOME}/archive/implementer.md`, `${HOME}/implementer.old.md`],
      spawn_constraints: { allowed_models: ['fixture/flash', 'fixture/k3'], allowed_efforts: ['high', 'max'], disallowed_tools: ['WebFetch'] },
      allowed_models: ['fixture/sol', 'fixture/k3'],
      model_profiles: [
        { alias: 'fixture/k3', when: 'The change is small and the context fits in 256k.', thinking_effort: 'max' },
        { alias: 'fixture/m3', when: 'Bulk mechanical edits across many files.', thinking_effort: 'high' },
      ],
    }),
    profile('think', {
      description: 'Hard architecture, authority and root-cause questions.', when_to_use: 'A question where a wrong framing is expensive.',
      prompt: 'Reason from evidence. State what you checked and what you could not verify.', pinned_model_alias: 'fixture/astra', thinking_effort: 'xhigh',
      subagents: ['explore'], allowed_models: ['fixture/astra'],
    }),
    profile('reviewer', {
      description: 'Independent review at a candidate boundary.', prompt: 'Review the candidate against the stated acceptance and report findings with evidence.',
      pinned_model_alias: 'fixture/so1', thinking_effort: 'max', subagents: ['explore'],
    }),
    profile('writer', {
      description: 'Long-form documents and public copy.', prompt: 'Write in the project voice. Keep claims to what the evidence supports.',
      pinned_model_alias: 'fixture/m3', thinking_effort: 'max', subagents: [],
    }),
    // Loses discovery: a same-name file in an extra directory.
    { ...profile('writer', { description: 'Older writer draft.', pinned_model_alias: 'fixture/k3', thinking_effort: 'high', subagents: [] }),
      source: 'extra', source_file: 'C:/Research/agents/writer.md' },
    profile('implementer-grok', {
      description: 'Implementer running on Grok Build.', prompt: IMPLEMENTER_PROMPT, executor: 'grok-acp',
      pinned_model_alias: 'grok-4.7', thinking_effort: 'xhigh', tools: ['Read', 'Edit', 'Bash'], service_tier: 'priority', subagents: [],
      executor_fields: {
        prompt: { state: 'mapped', reason: 'Sent to Grok Build as system_prompt_override. The Kiki default system prompt is not added.' },
        pinned_model_alias: { state: 'mapped' },
        thinking_effort: { state: 'mapped' },
        tools: { state: 'ignored', reason: 'Grok Build decides its own tool set; tool lists are kept but not sent.' },
        disallowed_tools: { state: 'ignored', reason: 'Grok Build decides its own tool set; tool lists are kept but not sent.' },
        service_tier: { state: 'ignored', reason: 'A Kiki provider setting; Grok Build bills through its own account.' },
        subagents: { state: 'applied' },
      },
    }),
    { ...profile('general', { description: 'Default subagent when a dispatch names no profile.', prompt: 'Handle the task you were given; report back plainly.', subagents: [] }),
      source_file: `${HOME}/builtin/general.md` },
    // Workspace-local agents (.kiki/agents in the workshop root).
    { ...profile('release-lead', { main: true, description: 'Runs a release for this repository.', prompt: 'Cut the release, run the checks, draft the notes.',
      pinned_model_alias: 'fixture/k3', thinking_effort: 'high', subagents: ['explore', 'reviewer'] }),
      source: 'workspace', source_file: 'C:/fixture/workshop/.kiki/agents/release-lead.md' },
    { ...profile('migrator', { description: 'Schema migrations for this repository.', prompt: 'Write reversible migrations only.',
      pinned_model_alias: 'fixture/sol', subagents: [] }),
      source: 'workspace', source_file: 'C:/fixture/workshop/.kiki/agents/migrator.md' },
  ],
  // GET /executors: native plus two external engines, one not installed.
  executors: [
    { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'grok-acp', label: 'Grok Build', protocol: 'acp', status: 'ready', version: '0.9.2', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'claude-acp', label: 'Claude Code', protocol: 'acp', status: 'unavailable', model_binding: 'mapped', thinking_binding: 'unavailable' },
    { id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.44.0', model_binding: 'mapped', thinking_binding: 'mapped' },
  ],
  shippedAgentProfiles: [
    { template_id: 'agent', status: 'clean', managed: true, main: true, description: 'General-purpose built-in assistant.', active_path: `${HOME}/builtin/agent.md` },
    { template_id: 'general', status: 'custom', managed: true, main: false, description: 'Default subagent when a dispatch names no profile.', active_path: `${HOME}/builtin/general.md` },
  ],
  fsFiles: {
    [`${HOME}/lead.md`]: {
      content: `${frontmatter([
        'name: lead', 'description: "Workspace lead: frames, delegates, accepts."', 'main: true', 'model_alias: fixture/k3', 'thinking_effort: max',
        'auto_compact: 200000', 'subagents:', '  - explore', '  - name: implementer', '    model_alias: fixture/sol', '    thinking_effort: max',
        '  - think', '  - name: reviewer', '    thinking_effort: high', '  - writer',
      ])}${LEAD_PROMPT}\n`,
    },
    [`${HOME}/implementer.md`]: {
      content: `${frontmatter([
        'name: implementer', 'description: Owns an engineering objective end to end.', 'model_alias: fixture/sol', 'thinking_effort: max',
        'allowed_models: [fixture/sol, fixture/k3]', 'subagents: [explore]', 'model_profiles:',
        '  - alias: fixture/k3', '    when: The change is small and the context fits in 256k.', '    thinking_effort: max',
        '  - alias: fixture/m3', '    when: Bulk mechanical edits across many files.', '    thinking_effort: high',
        '    request_params: { temperature: 0.2 }',
      ])}${IMPLEMENTER_PROMPT}\n`,
    },
  },
  sessions: [],
  snapshots: {},
};
