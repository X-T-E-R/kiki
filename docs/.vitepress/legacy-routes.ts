// Source pages use their canonical IA paths. Only redirect pages are rewritten.
export const legacyMoves = {
  'configuration/migration': 'getting-started/migration',
  'configuration/model-vocabulary': 'getting-started/model-vocabulary',
  'desktop/interface': 'guides/interface',
  'desktop/sessions': 'guides/sessions',
  'desktop/settings': 'guides/settings',
  'cli/interaction': 'guides/interaction',
  'cli/goals': 'guides/goals',
  'cli/slash-commands': 'reference/slash-commands',
  'cli/command': 'reference/command',
  'server/daemon': 'reference/command',
} as const

const commandAnchors: Record<string, Record<string, string>> = {
  en: {
    'start-or-reuse-the-daemon': 'kiki-serve',
    'manage-external-caller-seats': 'kiki-seat',
    'run-the-stdio-mcp-edge': 'kiki-mcp',
    'diagnose-the-connection': 'kiki-doctor',
    'inspect-prompt-fields': 'kiki-prompt-fields',
    'migration-from-kimi': 'kiki-migrate-config',
    'kiki-daemon-integration': 'kiki-serve',
  },
  zh: {
    '启动或复用-daemon': 'kiki-serve',
    '管理外部调用方席位': 'kiki-seat',
    '运行-stdio-mcp-边': 'kiki-mcp',
    '诊断连接': 'kiki-doctor',
    '检查提示词字段': 'kiki-prompt-fields',
    '从-kimi-迁移': 'kiki-migrate-config',
    'kiki-daemon-集成': 'kiki-serve',
  },
}

export const legacyRoutes = ['en', 'zh'].flatMap((locale) =>
  Object.entries(legacyMoves).map(([from, to]) => ({
    locale,
    from,
    to,
    anchors: Object.fromEntries(Object.entries(
      to === 'reference/command' ? commandAnchors[locale] : {},
    ).map(([oldAnchor, newAnchor]) => [`#${encodeURI(oldAnchor)}`, `#${newAnchor}`])),
  })),
)
