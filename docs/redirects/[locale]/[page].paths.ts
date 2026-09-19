import { legacyRoutes } from '../../.vitepress/legacy-routes'

export default {
  paths: () => legacyRoutes.map(({ locale, from, to, anchors }) => ({
    params: { locale, page: from, target: `/${locale}/${to}.html`, anchors },
    content: `# ${locale === 'zh' ? '页面已迁移' : 'Page moved'}

${locale === 'zh' ? `本页已迁移，请前往 [新页面](/${locale}/${to}.md)。` : `This page has moved. Continue to [the new page](/${locale}/${to}.md).`}
`,
  })),
}
