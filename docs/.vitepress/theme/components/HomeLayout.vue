<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useData, withBase } from 'vitepress'
import HomeHero from './HomeHero.vue'
import HomeFeatures from './HomeFeatures.vue'
import HomeQuickStart from './HomeQuickStart.vue'

const { Layout } = DefaultTheme
const { frontmatter, lang } = useData()
</script>

<template>
  <Layout>
    <template v-if="frontmatter.layout === 'home'" #home-hero-before>
      <div class="KikiHome">
        <HomeHero />
      </div>
    </template>

    <template v-if="frontmatter.layout === 'home'" #home-features-after>
      <div class="KikiHome">
        <HomeQuickStart />
        <HomeFeatures />
      </div>
    </template>

    <template #doc-footer-before>
      <p>
        <a :href="withBase(`/${lang.startsWith('zh') ? 'zh' : 'en'}/release-notes/changelog.html`)">
          {{ lang.startsWith('zh') ? '发布说明' : 'Release Notes' }}
        </a>
      </p>
    </template>
  </Layout>
</template>

<style>
/* Hide the default hero + features rendered by VitePress when our custom home is active.
   We keep frontmatter.layout: home so VitePress still applies layout-specific behavior. */
.VPHome > .VPHero {
  display: none;
}
.VPHome > .VPFeatures {
  display: none;
}
</style>
