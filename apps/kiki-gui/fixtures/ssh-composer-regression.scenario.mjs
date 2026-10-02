import nativeSsh from './native-ssh.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

const atDaysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString();

export default {
  ...nativeSsh,
  agentPanel: {
    context: 'live', owner: { profile: 'agent', agent_id: 'main' }, available: true,
    profile: { name: 'agent', restrict_models_to_menu: false }, targets: [],
  },
  sessions: [
    ...nativeSsh.sessions,
    ...Array.from({ length: 32 }, (_, index) => {
      const days = index < 16 ? 1 : index < 24 ? 4 : 30;
      return sessionRecord(`session_group_${index}`, {
        title: `Workspace investigation ${index + 1}: a long conversation title about implementation and verification`,
        created_at: atDaysAgo(days),
        updated_at: atDaysAgo(days),
      });
    }),
  ],
};
