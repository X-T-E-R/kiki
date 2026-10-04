<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'
import KimiLogo from './KimiLogo.vue'

const { lang } = useData()

const isZh = computed(() => lang.value.startsWith('zh'))

/**
 * The same frame the README leads with, so a GitHub visitor and a docs visitor
 * see one workbench rather than two. It is a copied asset, not a second source:
 * marketing/shots stays the master, and `marketing-collect.mjs` is the only
 * thing that copies it here.
 */
const heroShot = computed(() => withBase(isZh.value
  ? '/shots/index/hero-workbench.zh.png'
  : '/shots/index/hero-workbench.en.png'))

/**
 * The intrinsic size of the master frame, for the browser to reserve space
 * before it loads. The CSS then scales it down, so these attributes are a
 * layout hint rather than a rendered width — a phone must not inherit 2880px
 * of reserved width, which is what a hard attribute would do before the
 * stylesheet applies.
 */
const HERO_FRAME_WIDTH = 1440
const HERO_FRAME_HEIGHT = 900

const copy = computed(() => isZh.value
  ? {
      titleLead: 'Kiki',
      titleAccent: 'AI Agent',
      tagline: '跑在你自己机器上的开源 AI 智能体工作台：一个主会话带一队子智能体，长任务它自己推进，模型、提示词、角色、空间，每一层都归你。',
      heroAlt: 'Kiki 工作台：主会话派出的子智能体、进行中的目标和一条排队消息同屏可见。',
      primaryText: '快速上手',
      primaryHref: '/zh/getting-started/installation',
      secondaryText: '看看它能做什么',
      secondaryHref: '/zh/features/index',
      changelogText: '发布说明',
      changelogHref: '/zh/release-notes/changelog',
    }
  : {
      titleLead: 'Kiki',
      titleAccent: 'AI Agent',
      tagline: 'An open-source AI agent workbench on your machine: one lead session with a team of subagents, long work it pushes on by itself, and every layer — model, prompt, role, space — yours to set.',
      heroAlt: 'The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.',
      primaryText: 'Get Started',
      primaryHref: '/en/getting-started/installation',
      secondaryText: 'See what it does',
      secondaryHref: '/en/features/index',
      changelogText: 'Release Notes',
      changelogHref: '/en/release-notes/changelog',
    })
</script>

<template>
  <section class="KikiHero">
    <div class="KikiHero__halo" aria-hidden="true" />
    <div class="KikiHero__inner">
      <div class="KikiHero__logo">
        <KimiLogo :size="72" />
      </div>
      <h1 class="KikiHero__title">
        <span class="KikiHero__brand">{{ copy.titleLead }}</span>
        <span class="KikiHero__dot" />
        <span class="KikiHero__sub">{{ copy.titleAccent }}</span>
      </h1>
      <p class="KikiHero__tagline">{{ copy.tagline }}</p>
      <div class="KikiHero__actions">
        <a class="KikiBtn KikiBtn--primary" :href="withBase(copy.primaryHref)">
          {{ copy.primaryText }}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </a>
        <a class="KikiBtn KikiBtn--ghost" :href="withBase(copy.secondaryHref)">
          {{ copy.secondaryText }}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </a>
        <a class="KikiBtn KikiBtn--ghost" :href="withBase(copy.changelogHref)">
          {{ copy.changelogText }}
        </a>
      </div>
      <figure class="KikiHero__shot">
        <img
          class="KikiHero__shotImg"
          :src="heroShot"
          :alt="copy.heroAlt"
          :width="HERO_FRAME_WIDTH"
          :height="HERO_FRAME_HEIGHT"
          loading="eager"
          decoding="async"
        />
        <figcaption class="KikiHero__shotCaption">
          {{ isZh ? '真实界面渲染的示例场景，不代表模型性能实测。' : 'A rendered example scene of the real interface; it is not a model performance measurement.' }}
        </figcaption>
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
  align-items: baseline;
  justify-content: center;
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

.KikiHero__shotCaption {
  margin: 14px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vp-c-text-3);
  text-align: center;
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
