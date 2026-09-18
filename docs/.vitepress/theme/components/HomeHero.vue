<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'
import KimiLogo from './KimiLogo.vue'

const { lang } = useData()

const isZh = computed(() => lang.value.startsWith('zh'))

const copy = computed(() => isZh.value
  ? {
      titleLead: 'Kiki',
      titleAccent: 'AI Agent',
      tagline: '交互式通用 AI agent——桌面 GUI、CLI/TUI、共享 daemon 三端一体的独立产品。',
      primaryText: '快速上手',
      primaryHref: '/zh/getting-started/installation',
      secondaryText: '探索桌面应用',
      secondaryHref: '/zh/guides/interface',
      changelogText: '发布说明',
      changelogHref: '/zh/release-notes/changelog',
    }
  : {
      titleLead: 'Kiki',
      titleAccent: 'AI Agent',
      tagline: 'An interactive general AI agent — Desktop GUI, CLI/TUI, and a shared daemon unified in one product.',
      primaryText: 'Get Started',
      primaryHref: '/en/getting-started/installation',
      secondaryText: 'Explore Desktop App',
      secondaryHref: '/en/guides/interface',
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
  width: 960px;
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
</style>
