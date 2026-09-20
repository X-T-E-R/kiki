import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'
import { legacyRoutes } from './legacy-routes'

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

  srcExclude: ['AGENTS.md', 'superpowers/**', 'examples/**', 'maintainer/**'],

  // Code blocks are always rendered on the dark "shell" surface (theme vars), so
  // Shiki must always emit dark-theme token colors; a light/dark dual theme would
  // put dark-on-dark tokens in light mode.
  markdown: { theme: 'github-dark' },

  // Rewrites publish redirect pages at every old URL, without hiding the new pages.
  rewrites: Object.fromEntries(legacyRoutes.map(({ locale, from }) => [
    `redirects/${locale}/${from}.md`, `${locale}/${from}.md`,
  ])),

  transformPageData(pageData) {
    if (pageData.filePath === 'redirects/[locale]/[page].md') {
      pageData.frontmatter.head.push([
        'noscript', {},
        `<meta http-equiv="refresh" content="0; url=${base}${pageData.params!.target.slice(1)}">`,
      ])
    }
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
          { text: '定制', link: '/zh/customization/agent-profiles', activeMatch: '/zh/customization/' },
          { text: '服务器与集成', link: '/zh/server/local-server', activeMatch: '/zh/server/' },
          { text: '配置', link: '/zh/configuration/config-files', activeMatch: '/zh/configuration/' },
          { text: '参考手册', link: '/zh/reference/command', activeMatch: '/zh/(reference|release-notes)/' },
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
          ],
          '/zh/customization/': [
            {
              text: '定制',
              items: [
                { text: 'Agent profile 概念与设计', link: '/zh/customization/agent-profiles' },
                { text: 'Agent 与 subagent', link: '/zh/customization/agents' },
                { text: 'Agent Skills', link: '/zh/customization/skills' },
                { text: 'Plugins', link: '/zh/customization/plugins' },
                { text: 'Hooks', link: '/zh/customization/hooks' },
                { text: '提示词字段与覆写', link: '/zh/customization/prompt-fields' },
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
                { text: '模型选择词汇', link: '/zh/reference/model-vocabulary' },
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
          { text: 'Customization', link: '/en/customization/agent-profiles', activeMatch: '/en/customization/' },
          { text: 'Server & integration', link: '/en/server/local-server', activeMatch: '/en/server/' },
          { text: 'Configuration', link: '/en/configuration/config-files', activeMatch: '/en/configuration/' },
          { text: 'Reference', link: '/en/reference/command', activeMatch: '/en/(reference|release-notes)/' },
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
          ],
          '/en/customization/': [
            {
              text: 'Customization',
              items: [
                { text: 'Agent profiles: concepts', link: '/en/customization/agent-profiles' },
                { text: 'Agents and Subagents', link: '/en/customization/agents' },
                { text: 'Agent Skills', link: '/en/customization/skills' },
                { text: 'Plugins', link: '/en/customization/plugins' },
                { text: 'Hooks', link: '/en/customization/hooks' },
                { text: 'Prompt field overrides', link: '/en/customization/prompt-fields' },
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
                { text: 'Model selection vocabulary', link: '/en/reference/model-vocabulary' },
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
    plugins: [llmstxt({ ignoreFiles: ['redirects/**'] })],
  },
}))

if (config.vite?.optimizeDeps?.include) {
  config.vite.optimizeDeps.include = config.vite.optimizeDeps.include.filter(
    (dep) => !mermaidOptimizeDeps.includes(dep),
  )
}

for (const locale of ['en', 'zh']) {
  const sidebar = config.locales?.[locale]?.themeConfig?.sidebar
  if (sidebar && !Array.isArray(sidebar)) {
    sidebar[`/${locale}/release-notes/`] = sidebar[`/${locale}/reference/`]
  }
}

export default config
