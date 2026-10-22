<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

const { frontmatter, lang, page } = useData()

const isZh = computed(() => lang.value.startsWith('zh'))

interface FeatureFrontmatter {
  title?: string
  details?: string
  link?: string
}

interface DetailRun {
  value: string
  code: boolean
}

/**
 * The locale's `index.md` `features` frontmatter is the only source of the
 * cards' words and destinations: title, details, link. VitePress's own
 * VPFeatures is hidden by HomeLayout, so this component is what a reader
 * actually sees, and anything written here instead of read from the page is
 * how the visible cards once drifted from the written ones.
 */
const features = computed(() => ((frontmatter.value.features ?? []) as FeatureFrontmatter[])
  .filter((feature) => feature?.title)
  .map((feature) => ({
    title: feature.title ?? '',
    details: inlineRuns(feature.details ?? ''),
    href: feature.link ? resolveFeatureLink(feature.link) : null,
  })))

/**
 * Frontmatter strings never pass through Markdown, so the backticks that wrap
 * command and field names in `details` would otherwise print literally. Split
 * the string into plain and inline-code runs for the template to interpolate;
 * nothing here is rendered as HTML, so a `<` in a details string stays text.
 */
function inlineRuns(text: string): DetailRun[] {
  return text
    .split('`')
    .map((value, index) => ({ value, code: index % 2 === 1 }))
    .filter((run) => run.value.length > 0)
}

/**
 * Frontmatter links are written relative to the page (`./features/workbench`),
 * the way HomeHero reads its actions. Resolve them against the page's own
 * directory so `en/index.md` yields `/en/features/workbench`, then apply the
 * site base like every other link in this theme.
 */
function resolveFeatureLink(link: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//')) return link
  if (link.startsWith('/')) return withBase(link)
  const pageDir = page.value.relativePath.replace(/[^/]*$/, '')
  return withBase(`/${pageDir}${link.replace(/^\.\//, '')}`)
}

const sectionTitle = computed(() => isZh.value ? '功能介绍' : 'Features')
const sectionLede = computed(() => isZh.value
  ? '按你手头要办的事进入：每一页讲清它替你做什么，再链到完整步骤与字段说明。'
  : 'Enter from the task you have at hand: each page says what Kiki does with it, then links to the full steps and field reference.')

const ctaText = computed(() => isZh.value ? '看看它能做什么' : 'See what it does')
const allHref = computed(() => isZh.value ? '/zh/features/index' : '/en/features/index')
const allText = computed(() => isZh.value ? '全部功能' : 'All features')
</script>

<template>
  <section v-if="features.length" class="KikiHome__section KikiFeatures">
    <h2 class="KikiHome__sectionTitle">{{ sectionTitle }}</h2>
    <p class="KikiHome__sectionLede">{{ sectionLede }}</p>
    <div class="KikiFeatures__grid">
      <component
        :is="feature.href ? 'a' : 'div'"
        v-for="feature in features"
        :key="feature.title"
        class="KikiFeatures__card"
        :href="feature.href ?? undefined"
      >
        <h3 class="KikiFeatures__title">{{ feature.title }}</h3>
        <p v-if="feature.details.length" class="KikiFeatures__desc">
          <template v-for="(run, index) in feature.details" :key="index">
            <code v-if="run.code" class="KikiFeatures__code">{{ run.value }}</code>
            <template v-else>{{ run.value }}</template>
          </template>
        </p>
        <span v-if="feature.href" class="KikiFeatures__cta">
          {{ ctaText }}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </component>
    </div>
    <p class="KikiFeatures__all">
      <a class="KikiFeatures__allLink" :href="withBase(allHref)">
        {{ allText }}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </p>
  </section>
</template>

<style scoped>
.KikiFeatures__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}

@media (max-width: 960px) {
  .KikiFeatures__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .KikiFeatures__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.KikiFeatures__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 26px 24px;
  border-radius: var(--kiki-radius-card);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform var(--kiki-transition), border-color var(--kiki-transition),
              box-shadow var(--kiki-transition), background var(--kiki-transition);
  overflow: hidden;
}

.KikiFeatures__card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--kiki-brand-gradient-soft);
  opacity: 0;
  transition: opacity var(--kiki-transition);
  pointer-events: none;
  border-radius: inherit;
}

.KikiFeatures__card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--vp-shadow-2);
}
.KikiFeatures__card:hover::before {
  opacity: 1;
}

.KikiFeatures__card:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.KikiFeatures__title {
  position: relative;
  z-index: 1;
  font-size: 17.5px;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 0 0 10px;
  color: var(--vp-c-text-1);
  line-height: 1.35;
}

.KikiFeatures__desc {
  position: relative;
  z-index: 1;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 20px;
}

.KikiFeatures__code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--kiki-color-bubble-user);
  border: 1px solid var(--kiki-color-hairline);
  color: var(--vp-c-text-1);
  white-space: nowrap;
}

.KikiFeatures__cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
  /* The label carries the card's only small text, so it takes the ink token
     and clears AA (the brand orange measures 3.5:1 at this size). The arrow
     keeps the brand colour: decoration, not text. */
  color: var(--vp-c-text-1);
  margin-top: auto;
  transition: transform var(--kiki-transition);
}

.KikiFeatures__cta svg {
  color: var(--vp-c-brand-1);
}

.KikiFeatures__card:hover .KikiFeatures__cta {
  transform: translateX(3px);
}

/* The section's own exit link, styled like the quick-start footer link: one
   inline row of label and arrow, not an inline anchor around a block SVG. */
.KikiFeatures__all {
  margin: 28px 0 0;
}

.KikiFeatures__allLink {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform var(--kiki-transition);
}

.KikiFeatures__allLink svg {
  color: var(--vp-c-brand-1);
}

.KikiFeatures__allLink:hover {
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .KikiFeatures__card,
  .KikiFeatures__card:hover,
  .KikiFeatures__card:hover .KikiFeatures__cta,
  .KikiFeatures__allLink:hover {
    transform: none;
    transition: none;
  }
}
</style>
