import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { resolveConfig } from 'vitepress'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = await resolveConfig(root)
const { base, locales } = config.site
const html = (route) => readFileSync(path.join(config.outDir, `${route}.html`), 'utf8')
const moves = {
  'configuration/migration': 'getting-started/migration',
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
}
const sections = {
  'getting-started': [['installation', 'first-launch', 'desktop-app', 'use-cases'], ['migration']],
  guides: [['interface', 'sessions', 'settings'], ['interaction', 'goals']],
  customization: [['agent-profiles', 'agents', 'skills', 'plugins', 'hooks', 'prompt-fields', 'themes']],
  server: [['local-server', 'ide', 'acp'], ['rest-api', 'mcp', 'sdk']],
  configuration: [['config-files', 'providers', 'overrides', 'env-vars', 'data-locations']],
  reference: [['command', 'slash-commands', 'keyboard', 'tools', 'model-vocabulary'], ['changelog']],
}

function structural(value) {
  if (typeof value === 'string') return value.replace(/\/(en|zh)\//g, '/')
  if (Array.isArray(value)) return value.map(structural)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'text')
      .map(([key, item]) => [structural(key), structural(item)]))
  }
  return value
}

test('both locales have the approved six-section nav and mirrored sidebars', () => {
  assert.deepEqual(structural(locales.en.themeConfig), structural(locales.zh.themeConfig))
  for (const locale of ['en', 'zh']) {
    const { nav, sidebar } = locales[locale].themeConfig
    assert.deepEqual(nav.map(({ link }) => link.split('/')[2]), Object.keys(sections))
    for (const [section, groups] of Object.entries(sections)) {
      const actual = sidebar[`/${locale}/${section}/`]
      assert.deepEqual(actual.map(({ items }) => items.map(({ link }) => link.split('/').at(-1))), groups)
      for (const group of actual) {
        for (const { link } of group.items) {
          assert.match(html(link.slice(1)), /class="VPSidebar/)
        }
      }
    }
    assert.deepEqual(sidebar[`/${locale}/release-notes/`], sidebar[`/${locale}/reference/`])
    assert.match(`${locale}/release-notes/changelog.md`, new RegExp(nav.at(-1).activeMatch.slice(1)))
    assert.ok(html(`${locale}/index`).includes(`${base}${locale}/release-notes/changelog`))
    assert.match(html(`${locale}/reference/command`), new RegExp(`<footer[^>]*class="VPDocFooter"[\\s\\S]*?href="${base}${locale}/release-notes/changelog.html"`))
  }
  const pages = (locale) => readdirSync(path.join(root, locale), { recursive: true })
    .map((file) => file.replaceAll('\\', '/')).filter((file) => file.endsWith('.md')).sort()
  assert.deepEqual(pages('en'), pages('zh'))
})

test('all 26 old URLs publish redirect pages and all canonical destinations publish content', () => {
  assert.equal(Object.keys(config.rewrites.map).length, 26)
  for (const locale of ['en', 'zh']) {
    for (const [from, to] of Object.entries(moves)) {
      assert.equal(config.rewrites.map[`redirects/${locale}/${from}.md`], `${locale}/${from}.md`)
      assert.equal(config.rewrites.map[`${locale}/${to}.md`], undefined)
      const legacy = html(`${locale}/${from}`)
      assert.ok(legacy.includes(`href="${base}${locale}/${to}.html"`))
      assert.ok(legacy.includes(`<noscript><meta http-equiv="refresh" content="0; url=${base}${locale}/${to}.html"></noscript>`))
      assert.match(legacy, /<meta name="robots" content="noindex">/)
      assert.doesNotMatch(legacy, /<p>layout: page/)
      const llmsIndex = readFileSync(path.join(config.outDir, 'llms.txt'), 'utf8')
      assert.ok(!llmsIndex.includes(`/${locale}/${from}.md`), 'redirects must not enter the LLM index')
      assert.ok(llmsIndex.includes(`/${locale}/${to}.md`), 'canonical pages must remain in the LLM index')
      assert.doesNotMatch(html(`${locale}/${to}`), /<meta name="robots" content="noindex">/)
      const route = config.dynamicRoutes.routes.find(({ params }) => params.locale === locale && params.page === from)
      assert.equal(route.params.target, `/${locale}/${to}.html`)
      for (const target of Object.values(route.params.anchors)) {
        if (target.startsWith('/')) {
          const [targetPage, targetHash] = target.slice(1).split('#')
          assert.match(targetPage, new RegExp(`^${locale}/`))
          const targetHtml = html(targetPage.replace(/\.html$/, ''))
          assert.doesNotMatch(targetHtml, /<meta name="robots" content="noindex">/)
          if (targetHash) assert.ok(targetHtml.includes(`id="${decodeURI(targetHash)}"`), target)
        } else {
          assert.ok(html(`${locale}/${to}`).includes(`id="${target.slice(1)}"`), target)
        }
      }
    }
  }
})

test('redirect script preserves query strings and fragments, including merged command anchors', () => {
  const source = readFileSync(path.join(root, 'redirects/[locale]/[page].md'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .+$/gm, '')
  for (const route of config.dynamicRoutes.routes) {
    const { params } = route
    if (!params.target) continue
    for (const [hash, expected] of [['#unchanged-section', '#unchanged-section'], ...Object.entries(params.anchors)]) {
      let destination
      runInNewContext(source, {
        URL,
        onMounted: (callback) => callback(),
        useData: () => ({ params: { value: params } }),
        withBase: (target) => base + target.slice(1),
        window: { location: { origin: 'https://docs.example', search: '?from=bookmark', hash, replace: (url) => { destination = url } } },
      })
      if (expected.startsWith('/')) {
        const [targetPage, targetHash] = expected.slice(1).split('#')
        assert.equal(destination, `https://docs.example${base}${targetPage}?from=bookmark${targetHash ? `#${encodeURI(targetHash)}` : ''}`)
      } else {
        assert.equal(destination, `https://docs.example${base}${params.locale}/${moves[params.page]}.html?from=bookmark${expected}`)
      }
    }
  }
})

test('every rendered local page link and anchor resolves, and examples are not published', () => {
  const files = readdirSync(config.outDir, { recursive: true }).map((file) => file.replaceAll('\\', '/'))
  assert.ok(!files.some((file) => file.startsWith('examples/') && file.endsWith('.html')))
  const headingIds = new Map()
  const idsFor = (output) => {
    if (!headingIds.has(output)) {
      const ids = new Set()
      for (const [, doubleQuoted, singleQuoted] of readFileSync(path.join(config.outDir, output), 'utf8').matchAll(/\sid=(?:"([^"]*)"|'([^']*)')/g)) {
        ids.add(doubleQuoted ?? singleQuoted)
      }
      headingIds.set(output, ids)
    }
    return headingIds.get(output)
  }
  const hasAnchor = (output, hash) => {
    let fragment
    try {
      fragment = decodeURIComponent(hash.slice(1))
    } catch {
      return false
    }
    return idsFor(output).has(fragment)
  }
  const missing = new Set()
  const deadAnchors = new Set()
  for (const file of files.filter((file) => /^(en|zh)\/.*\.html$/.test(file))) {
    for (const [, doubleQuoted, singleQuoted] of html(file.slice(0, -5)).matchAll(/href=(?:"([^"]*)"|'([^']*)')/g)) {
      const href = doubleQuoted ?? singleQuoted
      if (!href || /^(https?:|mailto:|data:)/.test(href)) continue
      if (href.startsWith('#')) {
        if (!hasAnchor(file, href)) deadAnchors.add(`${file} -> ${href}`)
        continue
      }
      const url = new URL(href, `https://docs.example${base}${file}`)
      const pathname = decodeURI(url.pathname)
      if (!pathname.startsWith(base)) continue
      let output = pathname.slice(base.length)
      if (!/^(en|zh)\//.test(output)) continue
      if (!path.posix.basename(output).includes('.')) output += output.endsWith('/') ? 'index.html' : '.html'
      if (!existsSync(path.join(config.outDir, output))) {
        missing.add(`${file} -> ${href}`)
      } else if (url.hash && !hasAnchor(output, url.hash)) {
        deadAnchors.add(`${file} -> ${href}`)
      }
    }
  }
  assert.deepEqual([...missing], [])
  assert.deepEqual([...deadAnchors], [])
})
