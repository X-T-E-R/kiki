import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

const rawBase = process.env.VITEPRESS_BASE
const base = rawBase
  ? rawBase.startsWith('/')
    ? rawBase.endsWith('/') ? rawBase : `${rawBase}/`
    : `/${rawBase}/`
  : '/'

const mermaidOptimizeDeps = [
  '@braintree/sanitize-url',
  'dayjs',
  'debug',
  'cytoscape-cose-bilkent',
  'cytoscape',
]

const config = withMermaid(defineConfig({
  base,
  title: 'Kiki Docs',
  description: 'Kiki Product Documentation',

  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: `${base}favicon.ico` }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}kiki-logo.svg` }],
    ['meta', { name: 'theme-color', content: '#e8590c' }],
  ],

  srcExclude: ['AGENTS.md', 'superpowers/**', 'examples/**'],

  rewrites: {
    'zh/getting-started/migration.md': 'zh/configuration/migration.md',
    'en/getting-started/migration.md': 'en/configuration/migration.md',
    'zh/getting-started/model-vocabulary.md': 'zh/configuration/model-vocabulary.md',
    'en/getting-started/model-vocabulary.md': 'en/configuration/model-vocabulary.md',
    'zh/guides/interface.md': 'zh/desktop/interface.md',
    'en/guides/interface.md': 'en/desktop/interface.md',
    'zh/guides/sessions.md': 'zh/desktop/sessions.md',
    'en/guides/sessions.md': 'en/desktop/sessions.md',
    'zh/guides/settings.md': 'zh/desktop/settings.md',
    'en/guides/settings.md': 'en/desktop/settings.md',
    'zh/guides/interaction.md': 'zh/cli/interaction.md',
    'en/guides/interaction.md': 'en/cli/interaction.md',
    'zh/guides/goals.md': 'zh/cli/goals.md',
    'en/guides/goals.md': 'en/cli/goals.md',
    'zh/reference/slash-commands.md': 'zh/cli/slash-commands.md',
    'en/reference/slash-commands.md': 'en/cli/slash-commands.md',
    'zh/reference/command.md': 'zh/cli/command.md',
    'en/reference/command.md': 'en/cli/command.md',
  },

  locales: {
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Kiki 产品文档',
      description: 'Kiki 用户文档',
      themeConfig: {
        nav: [
          { text: '快速上手', link: '/zh/getting-started/installation', activeMatch: '/zh/getting-started/' },
          { text: '使用指南', link: '/zh/guides/interface', activeMatch: '/zh/guides/' },
          { text: '定制', link: '/zh/customization/agents', activeMatch: '/zh/customization/' },
          { text: '服务器与集成', link: '/zh/server/local-server', activeMatch: '/zh/server/' },
          { text: '配置', link: '/zh/configuration/config-files', activeMatch: '/zh/configuration/' },
          { text: '参考手册', link: '/zh/reference/command', activeMatch: '/zh/reference/' },
        ],
        sidebar: {
          '/zh/getting-started/': [
            {
              text: '快速上手',
              items: [
                { text: '安装', link: '/zh/getting-started/installation' },
                { text: '首次启动', link: '/zh/getting-started/first-launch' },
                { text: 'Kiki 桌面版', link: '/zh/getting-started/desktop-app' },
                { text: '常见使用案例', link: '/zh/getting-started/use-cases' },
              ],
            },
            {
              text: '迁移',
              items: [
                { text: '从 kimi-cli 迁移', link: '/zh/getting-started/migration' },
                { text: '模型词汇收敛路线', link: '/zh/getting-started/model-vocabulary' },
              ],
            },
          ],
          '/zh/guides/': [
            {
              text: '桌面应用',
              items: [
                { text: '界面导览', link: '/zh/guides/interface' },
                { text: '工作区与会话管理', link: '/zh/guides/sessions' },
                { text: '设置页导览', link: '/zh/guides/settings' },
              ],
            },
            {
              text: 'CLI 与 TUI',
              items: [
                { text: '交互与输入', link: '/zh/guides/interaction' },
                { text: '使用目标模式', link: '/zh/guides/goals' },
              ],
            },
          ],
          '/zh/server/': [
            {
              text: '使用',
              items: [
                { text: '本地服务与 API', link: '/zh/server/local-server' },
                { text: '在 IDE 中使用', link: '/zh/server/ide' },
                { text: 'kiki acp 子命令', link: '/zh/server/acp' },
              ],
            },
            {
              text: '协议与开发',
              items: [
                { text: '服务 API', link: '/zh/server/rest-api' },
                { text: 'Model Context Protocol', link: '/zh/server/mcp' },
                { text: 'Node.js SDK', link: '/zh/server/sdk' },
              ],
            },
            {
              text: '内部机制（面向维护者）',
              collapsed: true,
              items: [
                { text: 'Kiki 运行时边界', link: '/zh/server/architecture' },
                { text: '跨 host 会话边界', link: '/zh/server/cross-host-session-boundaries' },
              ],
            },
          ],
          '/zh/customization/': [
            {
              text: '定制',
              items: [
                { text: 'Agent 与 subagent', link: '/zh/customization/agents' },
                { text: '提示词字段与覆写', link: '/zh/customization/prompt-fields' },
                { text: 'Agent Skills', link: '/zh/customization/skills' },
                { text: 'Plugins', link: '/zh/customization/plugins' },
                { text: 'Hooks', link: '/zh/customization/hooks' },
                { text: '自定义主题', link: '/zh/customization/themes' },
              ],
            },
          ],
          '/zh/configuration/': [
            {
              text: '配置',
              items: [
                { text: '配置文件', link: '/zh/configuration/config-files' },
                { text: '平台与模型', link: '/zh/configuration/providers' },
                { text: '配置覆盖', link: '/zh/configuration/overrides' },
                { text: '环境变量', link: '/zh/configuration/env-vars' },
                { text: '数据路径', link: '/zh/configuration/data-locations' },
              ],
            },
          ],
          '/zh/reference/': [
            {
              text: '参考手册',
              items: [
                { text: 'kiki 命令', link: '/zh/reference/command' },
                { text: '斜杠命令', link: '/zh/reference/slash-commands' },
                { text: '键盘快捷键', link: '/zh/reference/keyboard' },
                { text: '内置工具', link: '/zh/reference/tools' },
              ],
            },
            {
              text: '发布说明',
              items: [
                { text: '变更记录', link: '/zh/release-notes/changelog' },
              ],
            },
          ],
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Kiki Docs',
      description: 'Kiki Product Documentation',
      themeConfig: {
        nav: [
          { text: 'Getting started', link: '/en/getting-started/installation', activeMatch: '/en/getting-started/' },
          { text: 'Guides', link: '/en/guides/interface', activeMatch: '/en/guides/' },
          { text: 'Customization', link: '/en/customization/agents', activeMatch: '/en/customization/' },
          { text: 'Server & integration', link: '/en/server/local-server', activeMatch: '/en/server/' },
          { text: 'Configuration', link: '/en/configuration/config-files', activeMatch: '/en/configuration/' },
          { text: 'Reference', link: '/en/reference/command', activeMatch: '/en/reference/' },
        ],
        sidebar: {
          '/en/getting-started/': [
            {
              text: 'Getting started',
              items: [
                { text: 'Installation', link: '/en/getting-started/installation' },
                { text: 'First launch', link: '/en/getting-started/first-launch' },
                { text: 'Kiki desktop', link: '/en/getting-started/desktop-app' },
                { text: 'Common use cases', link: '/en/getting-started/use-cases' },
              ],
            },
            {
              text: 'Migration',
              items: [
                { text: 'Migrating from kimi-cli', link: '/en/getting-started/migration' },
                { text: 'Model vocabulary convergence', link: '/en/getting-started/model-vocabulary' },
              ],
            },
          ],
          '/en/guides/': [
            {
              text: 'Desktop app',
              items: [
                { text: 'Interface overview', link: '/en/guides/interface' },
                { text: 'Workspaces and sessions', link: '/en/guides/sessions' },
                { text: 'Settings pages', link: '/en/guides/settings' },
              ],
            },
            {
              text: 'CLI & TUI',
              items: [
                { text: 'Interaction and input', link: '/en/guides/interaction' },
                { text: 'Using goals', link: '/en/guides/goals' },
              ],
            },
          ],
          '/en/server/': [
            {
              text: 'Usage',
              items: [
                { text: 'Local server and API', link: '/en/server/local-server' },
                { text: 'Using in IDEs', link: '/en/server/ide' },
                { text: 'kiki acp subcommand', link: '/en/server/acp' },
              ],
            },
            {
              text: 'Protocol & SDK',
              items: [
                { text: 'Server API', link: '/en/server/rest-api' },
                { text: 'Model Context Protocol', link: '/en/server/mcp' },
                { text: 'Node.js SDK', link: '/en/server/sdk' },
              ],
            },
            {
              text: 'Internals (Maintainers)',
              collapsed: true,
              items: [
                { text: 'Kiki runtime boundary', link: '/en/server/architecture' },
                { text: 'Cross-host session boundaries', link: '/en/server/cross-host-session-boundaries' },
              ],
            },
          ],
          '/en/customization/': [
            {
              text: 'Customization',
              items: [
                { text: 'Agents and Subagents', link: '/en/customization/agents' },
                { text: 'Prompt field overrides', link: '/en/customization/prompt-fields' },
                { text: 'Agent Skills', link: '/en/customization/skills' },
                { text: 'Plugins', link: '/en/customization/plugins' },
                { text: 'Hooks', link: '/en/customization/hooks' },
                { text: 'Custom Themes', link: '/en/customization/themes' },
              ],
            },
          ],
          '/en/configuration/': [
            {
              text: 'Configuration',
              items: [
                { text: 'Config Files', link: '/en/configuration/config-files' },
                { text: 'Providers and Models', link: '/en/configuration/providers' },
                { text: 'Config Overrides', link: '/en/configuration/overrides' },
                { text: 'Environment Variables', link: '/en/configuration/env-vars' },
                { text: 'Data Locations', link: '/en/configuration/data-locations' },
              ],
            },
          ],
          '/en/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'kiki command', link: '/en/reference/command' },
                { text: 'Slash commands', link: '/en/reference/slash-commands' },
                { text: 'Keyboard Shortcuts', link: '/en/reference/keyboard' },
                { text: 'Built-in Tools', link: '/en/reference/tools' },
              ],
            },
            {
              text: 'Release Notes',
              items: [
                { text: 'Changelog', link: '/en/release-notes/changelog' },
              ],
            },
          ],
        },
      },
    },
  },

  themeConfig: {
    logo: '/kiki-logo.svg',
    outline: [2, 3],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/X-T-E-R/kiki' },
    ],
  },

  vite: {
    optimizeDeps: {
      include: mermaidOptimizeDeps.map((dep) => `mermaid > ${dep}`),
    },
    plugins: [llmstxt()],
  },
}))

if (config.vite?.optimizeDeps?.include) {
  config.vite.optimizeDeps.include = config.vite.optimizeDeps.include.filter(
    (dep) => !mermaidOptimizeDeps.includes(dep),
  )
}

export default config
