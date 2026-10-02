import configured from './profile-editor.scenario.mjs';

const menu = {
  restrict_models_to_menu: false,
  declared_model_menu: { aliases: [], identities: [] },
  effective_model_aliases: ['fixture/k3'],
};

export default {
  ...configured,
  workspaces: [],
  sessions: [],
  snapshots: {},
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose assistant.', main: true, disabled: false, routes: [], ...menu },
    { name: 'auto-lead', source: 'user', workspace_id: 'wd_previous', source_file: 'C:/fixture/home/agents/auto-lead.md',
      description: 'Lead an engineering task from investigation through verification.', main: true, disabled: false,
      pinned_model_alias: 'fixture/k3', thinking_effort: 'high', routes: [], ...menu },
    { name: 'project-only', source: 'workspace', workspace_id: 'wd_previous',
      description: 'Available only in the previous project.', main: true, disabled: false, routes: [], ...menu },
  ],
};
