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
    ['meta', { name: 'theme-color', content: '#0a7aff' }],
  ],

  srcExclude: ['AGENTS.md', 'superpowers/**'],

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
          { text: '桌面应用', link: '/zh/desktop/interface', activeMatch: '/zh/desktop/' },
          { text: 'CLI 与 TUI', link: '/zh/cli/interaction', activeMatch: '/zh/cli/' },
          { text: '服务器与集成', link: '/zh/server/local-server', activeMatch: '/zh/server/' },
          { text: '定制', link: '/zh/customization/agents', activeMatch: '/zh/customization/' },
          { text: '配置', link: '/zh/configuration/config-files', activeMatch: '/zh/configuration/' },
          { text: '参考手册', link: '/zh/reference/tools', activeMatch: '/zh/reference/' },
          { text: '发布说明', link: '/zh/release-notes/changelog', activeMatch: '/zh/release-notes/' },
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
                { text: '从 kimi-cli 迁移', link: '/zh/configuration/migration' },
              ],
            },
          ],
          '/zh/desktop/': [
            {
              text: '桌面应用',
              items: [
                { text: '界面导览', link: '/zh/desktop/interface' },
                { text: '工作区与会话管理', link: '/zh/desktop/sessions' },
                { text: '设置页导览', link: '/zh/desktop/settings' },
              ],
            },
          ],
          '/zh/cli/': [
            {
              text: 'CLI 与 TUI',
              items: [
                { text: '交互与输入', link: '/zh/cli/interaction' },
                { text: '使用目标模式', link: '/zh/cli/goals' },
                { text: '斜杠命令', link: '/zh/cli/slash-commands' },
                { text: '命令参考', link: '/zh/cli/command' },
              ],
            },
          ],
          '/zh/server/': [
            {
              text: '服务器与集成',
              items: [
                { text: '本地服务与 API', link: '/zh/server/local-server' },
                { text: 'Kiki 运行时边界', link: '/zh/server/architecture' },
                { text: 'daemon、席位与迁移', link: '/zh/server/daemon' },
                { text: '服务 API', link: '/zh/server/rest-api' },
                { text: '在 IDE 中使用', link: '/zh/server/ide' },
                { text: 'kiki acp 子命令', link: '/zh/server/acp' },
                { text: 'Model Context Protocol', link: '/zh/server/mcp' },
                { text: 'Node.js SDK', link: '/zh/server/sdk' },
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
                { text: '模型词汇收敛路线', link: '/zh/configuration/model-vocabulary' },
              ],
            },
          ],
          '/zh/reference/': [
            {
              text: '参考手册',
              items: [
                { text: '内置工具', link: '/zh/reference/tools' },
                { text: '键盘快捷键', link: '/zh/reference/keyboard' },
              ],
            },
          ],
          '/zh/release-notes/': [
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
          { text: 'Desktop app', link: '/en/desktop/interface', activeMatch: '/en/desktop/' },
          { text: 'CLI & TUI', link: '/en/cli/interaction', activeMatch: '/en/cli/' },
          { text: 'Server & integration', link: '/en/server/local-server', activeMatch: '/en/server/' },
          { text: 'Customization', link: '/en/customization/agents', activeMatch: '/en/customization/' },
          { text: 'Configuration', link: '/en/configuration/config-files', activeMatch: '/en/configuration/' },
          { text: 'Reference', link: '/en/reference/tools', activeMatch: '/en/reference/' },
          { text: 'Release Notes', link: '/en/release-notes/changelog', activeMatch: '/en/release-notes/' },
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
                { text: 'Migrating from kimi-cli', link: '/en/configuration/migration' },
              ],
            },
          ],
          '/en/desktop/': [
            {
              text: 'Desktop app',
              items: [
                { text: 'Interface overview', link: '/en/desktop/interface' },
                { text: 'Workspaces and sessions', link: '/en/desktop/sessions' },
                { text: 'Settings pages', link: '/en/desktop/settings' },
              ],
            },
          ],
          '/en/cli/': [
            {
              text: 'CLI & TUI',
              items: [
                { text: 'Interaction and input', link: '/en/cli/interaction' },
                { text: 'Using goals', link: '/en/cli/goals' },
                { text: 'Slash commands', link: '/en/cli/slash-commands' },
                { text: 'Command reference', link: '/en/cli/command' },
              ],
            },
          ],
          '/en/server/': [
            {
              text: 'Server & integration',
              items: [
                { text: 'Local server and API', link: '/en/server/local-server' },
                { text: 'Kiki runtime boundary', link: '/en/server/architecture' },
                { text: 'Daemon, seats, and migration', link: '/en/server/daemon' },
                { text: 'Server API', link: '/en/server/rest-api' },
                { text: 'Using in IDEs', link: '/en/server/ide' },
                { text: 'kiki acp subcommand', link: '/en/server/acp' },
                { text: 'Model Context Protocol', link: '/en/server/mcp' },
                { text: 'Node.js SDK', link: '/en/server/sdk' },
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
                { text: 'Model vocabulary convergence', link: '/en/configuration/model-vocabulary' },
              ],
            },
          ],
          '/en/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'Built-in Tools', link: '/en/reference/tools' },
                { text: 'Keyboard Shortcuts', link: '/en/reference/keyboard' },
              ],
            },
          ],
          '/en/release-notes/': [
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
