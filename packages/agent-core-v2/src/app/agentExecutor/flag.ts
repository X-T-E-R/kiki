import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const LOCAL_SESSION_RESUME_FLAG = 'local_session_resume';

registerFlagDefinition({
  id: LOCAL_SESSION_RESUME_FLAG,
  title: 'Resume local executor sessions',
  description: 'Attach local Claude and Codex sessions to new Kiki sessions',
  env: 'KIKI_EXPERIMENTAL_LOCAL_SESSION_RESUME',
  default: true,
  surface: 'both',
});
