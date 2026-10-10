<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'
import KimiLogo from './KimiLogo.vue'

const { frontmatter, lang, page } = useData()

const isZh = computed(() => lang.value.startsWith('zh'))

interface HeroAction {
  theme?: 'brand' | 'alt'
  text: string
  link: string
}

interface HeroFrontmatter {
  name?: string
  text?: string
  tagline?: string
  actions?: HeroAction[]
}

/**
 * The locale's `index.md` `hero` frontmatter is the only source of the hero's
 * words and buttons. VitePress's own VPHero is hidden by HomeLayout, so this
 * component is what a reader actually sees; keeping a second copy here is how
 * the visible headline once drifted from the written one.
 */
const hero = computed<HeroFrontmatter>(() => frontmatter.value.hero ?? {})

/**
 * Frontmatter links are written relative to the page (`./getting-started/…`),
 * the way VitePress's default hero reads them. Resolve them against the page's
 * own directory so `en/index.md` yields `/en/getting-started/installation`,
 * then apply the site base like every other link in this theme.
 */
function resolveHeroLink(link: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//')) return link
  if (link.startsWith('/')) return withBase(link)
  const pageDir = page.value.relativePath.replace(/[^/]*$/, '')
  return withBase(`/${pageDir}${link.replace(/^\.\//, '')}`)
}

/**
 * The brand action leads with a chevron, the first alternate action ("see what
 * it does") carries an arrow, and any later alternate stays a plain link — the
 * same visual weight the hero has always given its three buttons.
 */
const actions = computed(() => {
  let altSeen = 0
  return (hero.value.actions ?? []).map((action) => {
    const isBrand = action.theme !== 'alt'
    const icon = isBrand ? 'chevron' : altSeen++ === 0 ? 'arrow' : null
    return {
      text: action.text,
      href: resolveHeroLink(action.link),
      variant: isBrand ? 'primary' : 'ghost',
      icon,
    }
  })
})

/** The screenshot's description belongs to the screenshot, so it stays here. */
const heroAlt = computed(() => isZh.value
  ? 'Kiki 工作台：主会话派出的子智能体、进行中的目标和一条排队消息同屏可见。'
  : 'The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.')

/**
 * The same frame the README leads with, so a GitHub visitor and a docs visitor
 * see one workbench rather than two. It is a copied asset, not a second source:
 * marketing/shots stays the master, and `marketing-collect.mjs` is the only
 * thing that copies it here.
 */
const heroShot = computed(() => withBase(isZh.value
  ? '/shots/index/wl-20261005-hero-workbench.zh.png'
  : '/shots/index/wl-20261005-hero-workbench.en.png'))

/**
 * The intrinsic size of the master frame, for the browser to reserve space
 * before it loads. The CSS then scales it down, so these attributes are a
 * layout hint rather than a rendered width — a phone must not inherit 2880px
 * of reserved width, which is what a hard attribute would do before the
 * stylesheet applies.
 */
const HERO_FRAME_WIDTH = 1440
const HERO_FRAME_HEIGHT = 900
</script>

<template>
  <section class="KikiHero">
    <div class="KikiHero__halo" aria-hidden="true" />
    <div class="KikiHero__inner">
      <div class="KikiHero__logo">
        <KimiLogo :size="72" />
      </div>
      <h1 class="KikiHero__title">
        <span class="KikiHero__brand">{{ hero.name }}</span>
        <span v-if="hero.text" class="KikiHero__dot" />
        <span v-if="hero.text" class="KikiHero__sub">{{ hero.text }}</span>
      </h1>
      <p v-if="hero.tagline" class="KikiHero__tagline">{{ hero.tagline }}</p>
      <div v-if="actions.length" class="KikiHero__actions">
        <a
          v-for="action in actions"
          :key="action.href"
          :class="['KikiBtn', `KikiBtn--${action.variant}`]"
          :href="action.href"
        >
          {{ action.text }}
          <svg v-if="action.icon === 'chevron'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="action.icon === 'arrow'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </a>
      </div>
      <figure class="KikiHero__shot">
        <img
          class="KikiHero__shotImg"
          :src="heroShot"
          :alt="heroAlt"
          :width="HERO_FRAME_WIDTH"
          :height="HERO_FRAME_HEIGHT"
          loading="eager"
          decoding="async"
        />
      </figure>
    </div>
  </section>
</template>

<style scoped>
.KikiHero {
  position: relative;
  padding: clamp(64px, 10vw, 120px) 0 clamp(40px, 6vw, 80px);
  overflow: hidden;
}

.KikiHero__halo {
  position: absolute;
  top: -100px;
  left: 50%;
  /* Fixed 960px is wider than a phone. Clamping it to the section keeps the
     decoration inside the hero instead of letting it extend the page's
     scrollable width, without clipping anything the reader can see. */
  width: min(960px, 100%);
  height: 540px;
  transform: translateX(-50%);
  background:
    radial-gradient(closest-side, rgba(232, 89, 12, 0.14), transparent 70%),
    radial-gradient(closest-side, rgba(255, 122, 41, 0.10) 30%, transparent 75%);
  filter: blur(48px);
  pointer-events: none;
  z-index: 0;
  opacity: 0.8;
}
:global(.dark) .KikiHero__halo {
  opacity: 0.65;
  background:
    radial-gradient(closest-side, rgba(255, 131, 64, 0.20), transparent 70%),
    radial-gradient(closest-side, rgba(217, 72, 15, 0.14) 30%, transparent 75%);
}

.KikiHero__inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.KikiHero__logo {
  margin-bottom: 24px;
  filter: drop-shadow(0 10px 24px rgba(232, 89, 12, 0.22));
  transition: transform var(--kiki-transition);
}
.KikiHero__logo:hover {
  transform: translateY(-2px) scale(1.02);
}

.KikiHero__title {
  display: inline-flex;
  /* The accent slot is the positioning line, not a two-word label, so on a
     phone it must be able to drop under the brand rather than push the page
     wider than the screen. */
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  row-gap: 0.12em;
  max-width: 100%;
  font-family: var(--kiki-font-display);
  font-size: clamp(42px, 7vw, 82px);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.05;
  margin: 0 0 20px;
  color: var(--vp-c-text-1);
}

.KikiHero__brand {
  font-variation-settings: "opsz" 40;
}

.KikiHero__dot {
  display: inline-block;
  width: clamp(8px, 1.2vw, 14px);
  height: clamp(8px, 1.2vw, 14px);
  border-radius: 50%;
  background: var(--kiki-color-accent);
  margin: 0 clamp(8px, 1.2vw, 14px) clamp(2px, 0.5vw, 6px);
}

.KikiHero__sub {
  font-family: var(--vp-font-family-base);
  font-weight: 500;
  font-size: 0.55em;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--vp-c-text-2);
}

.KikiHero__tagline {
  font-size: clamp(16px, 1.6vw, 20px);
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 660px;
  margin: 0 0 40px;
}

.KikiHero__actions {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  justify-content: center;
}

@media (max-width: 480px) {
  .KikiHero__actions {
    width: 100%;
    flex-direction: column;
  }
  .KikiHero__actions .KikiBtn {
    width: 100%;
  }
}

/* The hero frame: one screen of the real workbench. It sits at the width of
   the reading column so the chips stay legible instead of shrinking into a
   thumbnail, and it reads as an inset surface rather than a floating banner. */
.KikiHero__shot {
  width: 100%;
  max-width: 980px;
  margin: clamp(40px, 5vw, 64px) auto 0;
}

.KikiHero__shotImg {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 24px 64px -32px rgba(30, 24, 16, 0.38), 0 2px 8px -4px rgba(30, 24, 16, 0.16);
  background: var(--vp-c-bg-alt);
}

:global(.dark) .KikiHero__shotImg {
  box-shadow: 0 28px 72px -32px rgba(0, 0, 0, 0.72), 0 2px 8px -4px rgba(0, 0, 0, 0.5);
}

@media (prefers-reduced-motion: no-preference) {
  .KikiHero__shotImg {
    transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 420ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .KikiHero__shot:hover .KikiHero__shotImg {
    transform: translateY(-4px) scale(1.006);
  }
}

@media (prefers-reduced-motion: reduce) {
  .KikiHero__shot:hover .KikiHero__shotImg {
    transform: none;
  }
}
</style>
