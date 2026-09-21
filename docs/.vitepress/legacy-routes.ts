// Source pages use their canonical IA paths. Only redirect pages are rewritten.
export const legacyMoves = {
  'configuration/model-vocabulary': 'reference/model-vocabulary',
  'getting-started/model-vocabulary': 'reference/model-vocabulary',
  'desktop/interface': 'guides/interface',
  'desktop/sessions': 'guides/sessions',
  'desktop/settings': 'guides/settings',
  'cli/interaction': 'guides/interaction',
  'cli/goals': 'guides/goals',
  'cli/slash-commands': 'reference/slash-commands',
  'cli/command': 'reference/command',
  'server/daemon': 'reference/command',
  'server/architecture': 'server/local-server',
  'server/cross-host-session-boundaries': 'server/local-server',
} as const

const commandAnchors: Record<string, Record<string, string>> = {
  en: {
    'start-or-reuse-the-daemon': 'kiki-serve',
    'manage-external-caller-seats': 'kiki-seat',
    'run-the-stdio-mcp-edge': 'kiki-mcp',
    'diagnose-the-connection': 'kiki-doctor',
    'inspect-prompt-fields': 'kiki-prompt-fields',
    'kiki-daemon-integration': 'kiki-serve',
  },
  zh: {
    '启动或复用-daemon': 'kiki-serve',
    '管理外部调用方席位': 'kiki-seat',
    '运行-stdio-mcp-边': 'kiki-mcp',
    '诊断连接': 'kiki-doctor',
    '检查提示词字段': 'kiki-prompt-fields',
    'kiki-daemon-集成': 'kiki-serve',
  },
}

// Anchors of moved pages whose content landed on a different public page.
// Keyed by the `from` page; a value starting with '/' is a full site path
// (cross-page), anything else is a same-page anchor on the `to` page.
const mergedPageAnchors: Record<string, Record<string, Record<string, string>>> = {
  'server/architecture': {
    en: {
      'choose-the-command-and-runtime': '/en/server/local-server.html',
      'separate-the-gui-server-and-clients': '/en/server/local-server.html',
      'use-one-runtime-home': '/en/server/local-server.html#authentication',
      'integrate-peer-thread-communication': '/en/server/rest-api.html#session-leases-and-peer-threads',
    },
    zh: {
      '选择命令和运行时': '/zh/server/local-server.html',
      '区分-gui-服务端和客户端': '/zh/server/local-server.html',
      '使用唯一运行时-home': '/zh/server/local-server.html#鉴权',
      '集成-peer-thread-通信': '/zh/server/rest-api.html#会话租约与-peer-thread',
    },
  },
  'server/cross-host-session-boundaries': {
    en: {
      'what-a-host-means-here': '/en/server/rest-api.html#session-leases-and-peer-threads',
      'decision-maintain-isolation': '/en/server/local-server.html#authentication',
      'what-is-not-a-bridge': '/en/server/local-server.html#authentication',
      'preserve-data-isolation': '/en/server/local-server.html#authentication',
    },
    zh: {
      '此处-host-的含义': '/zh/server/rest-api.html#会话租约与-peer-thread',
      '裁决-维持隔离': '/zh/server/local-server.html#鉴权',
      '哪些做法不属于桥接': '/zh/server/local-server.html#鉴权',
      '保持数据隔离': '/zh/server/local-server.html#鉴权',
    },
  },
}

export const legacyRoutes = ['en', 'zh'].flatMap((locale) =>
  Object.entries(legacyMoves).map(([from, to]) => ({
    locale,
    from,
    to,
    anchors: Object.fromEntries(Object.entries(
      to === 'reference/command' ? commandAnchors[locale] : (mergedPageAnchors[from]?.[locale] ?? {}),
    ).map(([oldAnchor, newAnchor]) => [
      `#${encodeURI(oldAnchor)}`,
      newAnchor.startsWith('/') ? newAnchor : `#${newAnchor}`,
    ])),
  })),
)
