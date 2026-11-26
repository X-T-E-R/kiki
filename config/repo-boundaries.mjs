export const NON_NPM_SURFACES = [
  'apps/kiki-android',
  'apps/kiki-gui/mobile',
];

export const IGNORED_NON_WORKSPACE_DIRS = new Set([]);

export const RETIRED_SCOPE_PATTERNS = [
  {
    pattern: /@moonshot-ai\/[a-z0-9-]+/g,
    fix: 'Replace retired @moonshot-ai/* scope with @kiki/*.',
  },
  {
    pattern: /\bpackages\/agent-core(?![-a-z0-9])/g,
    fix: 'Replace retired packages/agent-core reference with packages/agent-core-v2.',
  },
  {
    pattern: /\bkimi-code-mini-bench\b/g,
    fix: 'Remove dead kimi-code-mini-bench reference or point to an existing test suite.',
  },
  {
    pattern: /@kiki\/minidb\b|\bpackages\/minidb\b/g,
    fix: 'Remove retired @kiki/minidb / packages/minidb reference.',
  },
  {
    pattern: /@kiki\/dsh-compat\b|\bpackages\/dsh-compat\b/g,
    fix: 'Remove retired @kiki/dsh-compat / packages/dsh-compat reference.',
  },
];

export const THROWAWAY_FILE_PATTERNS = [
  {
    pattern: /(?:^|\/)(?:HANDOVER-|HANDOFF-|handoff\.md)/i,
    reason: 'tracked agent handoff/working note',
  },
  {
    pattern: /(?:^|\/)[^/]+-(?:mockup|demo|demos|designs)\.html$/i,
    reason: 'tracked throwaway HTML mockup/demo',
  },
];

export const BOUNDARY_RULES = [
  {
    id: 'protocol',
    root: 'packages/protocol',
    allowedInternal: new Set(['@kiki/plugin-sdk', '@kiki/transcript']),
    forbiddenInternal: new Set(['@kiki/agent-core-v2', '@kiki/kap-server', '@kiki/session-core']),
    forbiddenExternal: [
      /^react(?:$|\/)/,
      /^react-dom(?:$|\/)/,
      /^@tauri-apps\//,
      /^@capacitor\//,
      /^vscode$/,
    ],
    forbiddenGlobals: ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'],
    forbiddenPlatformFlags: ['isTauri', 'isCapacitor', 'isNative'],
  },
  {
    id: 'transcript',
    root: 'packages/transcript',
    allowedInternal: new Set([]),
    forbiddenInternal: new Set([
      '@kiki/agent-core-v2',
      '@kiki/kap-server',
      '@kiki/session-core',
      '@kiki/transcript-live',
    ]),
    forbiddenExternal: [
      /^react(?:$|\/)/,
      /^react-dom(?:$|\/)/,
      /^@tauri-apps\//,
      /^@capacitor\//,
      /^vscode$/,
      /^node:/,
    ],
    forbiddenGlobals: ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'],
    forbiddenPlatformFlags: ['isTauri', 'isCapacitor', 'isNative'],
  },
  {
    id: 'session-core',
    root: 'packages/session-core',
    allowedInternal: new Set(['@kiki/klient', '@kiki/protocol', '@kiki/transcript']),
    forbiddenInternal: new Set(['@kiki/pi-tui', '@kiki/kap-server', '@kiki/agent-core-v2']),
    forbiddenExternal: [
      /^react(?:$|\/)/,
      /^react-dom(?:$|\/)/,
      /^@tauri-apps\//,
      /^@capacitor\//,
      /^vscode$/,
    ],
    forbiddenGlobals: ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'],
    allowedForbiddenGlobalFiles: new Set([
      'packages/session-core/src/commands/sessionActions.ts',
      'packages/session-core/src/composer/drafts.ts',
      'packages/session-core/src/composer/selectionQuote.ts',
      'packages/session-core/src/session/sessionController.ts',
      'packages/session-core/src/settings/layoutPrefs.ts',
      'packages/session-core/src/settings/onboarding.ts',
      'packages/session-core/src/settings/sessionReadState.ts',
      'packages/session-core/src/settings/settings.ts',
      'packages/session-core/src/settings/settingsTransfer.ts',
      'packages/session-core/src/settings/terminalPrefs.ts',
      'packages/session-core/src/storage/spaceStorage.ts',
    ]),
    forbiddenPlatformFlags: ['isTauri', 'isCapacitor', 'isNative'],
  },
  {
    id: 'transcript-live',
    root: 'packages/transcript-live',
    allowedInternal: new Set(['@kiki/agent-core-v2', '@kiki/protocol', '@kiki/transcript']),
    forbiddenInternal: new Set(['@kiki/kap-server', '@kiki/session-core']),
    forbiddenExternal: [/^react(?:$|\/)/, /^react-dom(?:$|\/)/, /^@tauri-apps\//],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: [],
  },
  {
    id: 'agent-core-v2',
    root: 'packages/agent-core-v2',
    allowedInternal: new Set([
      '@kiki/acp-client',
      '@kiki/agent-profiles',
      '@kiki/codex-client',
      '@kiki/cordis-runtime',
      '@kiki/kaos',
      '@kiki/lexical',
      '@kiki/oauth',
      '@kiki/plugin-sdk',
      '@kiki/protocol',
      '@kiki/tree-sitter-bash',
    ]),
    forbiddenInternal: new Set(['@kiki/transcript-live', '@kiki/kap-server', '@kiki/session-core']),
    forbiddenExternal: [/^react(?:$|\/)/, /^react-dom(?:$|\/)/, /^@tauri-apps\//],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: [],
  },
  {
    id: 'klient',
    root: 'packages/klient',
    allowedInternal: new Set(['@kiki/agent-core-v2', '@kiki/protocol', '@kiki/transcript']),
    forbiddenInternal: new Set([
      '@kiki/kap-server',
      '@kiki/session-core',
      '@kiki/cli',
      '@kiki/gui',
    ]),
    forbiddenExternal: [/^react(?:$|\/)/, /^react-dom(?:$|\/)/, /^@tauri-apps\//],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: [],
  },
  {
    id: 'kimi-code',
    root: 'apps/kimi-code',
    forbiddenInternal: new Set(['@kiki/agent-core-v2']),
    allowedForbiddenImportFiles: new Set([
      'apps/kimi-code/src/cli/sub/doctor.ts',
      'apps/kimi-code/src/cli/v2/validate-config.ts',
      'apps/kimi-code/src/constant/app.ts',
      'apps/kimi-code/src/utils/plugin-marketplace.ts',
    ]),
    allowedRelativeEscapePatterns: [/^scripts\/external-harness\//],
    forbiddenExternal: [/^react(?:$|\/)/, /^react-dom(?:$|\/)/, /^@tauri-apps\//],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: [],
  },
  {
    id: 'kiki-desktop',
    root: 'apps/kiki-desktop',
    forbiddenInternal: new Set(['@kiki/agent-core-v2', '@kiki/kap-server', '@kiki/gui']),
    allowedRelativeEscapePatterns: [/^scripts\/ccp-chaos\//],
    forbiddenExternal: [
      /^react(?:$|\/)/,
      /^react-dom(?:$|\/)/,
      /^@tauri-apps\//,
      /^@capacitor\//,
      /^vscode$/,
    ],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: ['isTauri', 'isCapacitor'],
  },
  {
    id: 'kiki-gui',
    root: 'apps/kiki-gui',
    forbiddenInternal: new Set(['@kiki/agent-core-v2', '@kiki/kap-server', '@kiki/node-sdk']),
    forbiddenExternal: [],
    forbiddenGlobals: [],
    forbiddenPlatformFlags: [],
  },
];
