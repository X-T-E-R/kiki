<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed, ref } from 'vue'

const { lang } = useData()
const isZh = computed(() => lang.value.startsWith('zh'))

const downloadDesktopCommand = 'https://github.com/X-T-E-R/kiki/releases'
const runCliCommand = 'kiki'

const copy = computed(() => isZh.value
  ? {
      title: '即刻体验 Kiki',
      lede: '选择适合你的交互界面——推荐下载独立桌面应用，或直接在终端中运行 CLI。',
      desktopLabel: '桌面端 GUI (推荐)',
      cliLabel: '终端 CLI / TUI',
      copyHint: '复制',
      copiedHint: '已复制',
      downloadHint: '前往下载',
      ctaText: '查看完整安装与部署指南',
      ctaHref: '/zh/getting-started/installation',
    }
  : {
      title: 'Get Started with Kiki',
      lede: 'Choose your preferred form factor — grab the standalone desktop app or launch the CLI in your terminal.',
      desktopLabel: 'Desktop GUI (Recommended)',
      cliLabel: 'Terminal CLI / TUI',
      copyHint: 'Copy',
      copiedHint: 'Copied',
      downloadHint: 'Releases',
      ctaText: 'Read the full installation guide',
      ctaHref: '/en/getting-started/installation',
    })

const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function copyText(value: string, key: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  navigator.clipboard.writeText(value).then(() => {
    copiedKey.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedKey.value = null }, 1600)
  })
}
</script>

<template>
  <section class="KikiHome__section KikiQuick">
    <h2 class="KikiHome__sectionTitle">{{ copy.title }}</h2>
    <p class="KikiHome__sectionLede">{{ copy.lede }}</p>

    <div class="KikiQuick__grid">
      <!-- Desktop Download Block -->
      <div class="KikiQuick__block">
        <div class="KikiQuick__header">
          <span class="KikiQuick__badge">GUI</span>
          <span class="KikiQuick__label">{{ copy.desktopLabel }}</span>
        </div>
        <div class="KikiQuick__content">
          <p class="KikiQuick__desc">
            {{ isZh ? '开箱即用的原生桌面客户端，内置完整服务与可视化任务管理。' : 'Ready-to-use desktop application with built-in server and visual sessions.' }}
          </p>
          <div class="KikiQuick__cmd">
            <code>{{ downloadDesktopCommand }}</code>
            <a
              class="KikiQuick__btn"
              :href="downloadDesktopCommand"
              target="_blank"
              rel="noopener"
            >
              {{ copy.downloadHint }}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      </div>

      <!-- CLI Run Block -->
      <div class="KikiQuick__block">
        <div class="KikiQuick__header">
          <span class="KikiQuick__badge KikiQuick__badge--cli">CLI</span>
          <span class="KikiQuick__label">{{ copy.cliLabel }}</span>
        </div>
        <div class="KikiQuick__content">
          <p class="KikiQuick__desc">
            {{ isZh ? '将 kiki 放入 PATH，在任意项目目录下直接开启专注会话。' : 'Place the binary in your PATH and launch an agent session anywhere.' }}
          </p>
          <div class="KikiQuick__cmd">
            <code><span class="KikiQuick__prompt">$</span> {{ runCliCommand }}</code>
            <button
              type="button"
              class="KikiQuick__btn"
              @click="copyText(runCliCommand, 'cli')"
              :aria-label="copy.copyHint"
            >
              <template v-if="copiedKey === 'cli'">{{ copy.copiedHint }}</template>
              <template v-else>{{ copy.copyHint }}</template>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="KikiQuick__footer">
      <a class="KikiQuick__more" :href="withBase(copy.ctaHref)">
        {{ copy.ctaText }}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </div>
  </section>
</template>

<style scoped>
.KikiQuick__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  margin-bottom: 28px;
}

@media (max-width: 768px) {
  .KikiQuick__grid {
    grid-template-columns: 1fr;
  }
}

.KikiQuick__block {
  display: flex;
  flex-direction: column;
  padding: 24px;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--kiki-radius-card);
  transition: border-color var(--kiki-transition), box-shadow var(--kiki-transition);
}
.KikiQuick__block:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--vp-shadow-2);
}

.KikiQuick__header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.KikiQuick__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 700;
  border-radius: var(--kiki-radius-chip);
  background: var(--kiki-color-accent-soft);
  color: var(--kiki-color-accent-deep);
}
:global(.dark) .KikiQuick__badge {
  color: var(--kiki-color-accent);
}
.KikiQuick__badge--cli {
  background: var(--kiki-color-bubble-user);
  color: var(--vp-c-text-1);
}

.KikiQuick__label {
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.KikiQuick__desc {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0 0 16px;
  min-height: 40px;
}

.KikiQuick__cmd {
  position: relative;
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: var(--kiki-color-shell);
  border: 1px solid var(--kiki-color-hairline);
  border-radius: var(--kiki-radius-code);
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
  color: #fffdf8;
  overflow: hidden;
}
:global(.dark) .KikiQuick__cmd {
  border-color: var(--kiki-color-hairline-strong);
}

.KikiQuick__cmd code {
  flex: 1;
  white-space: nowrap;
  overflow-x: auto;
  background: transparent !important;
  color: inherit;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
  border-radius: 0;
}

.KikiQuick__prompt {
  color: var(--kiki-color-accent);
  margin-right: 8px;
  user-select: none;
  font-weight: 600;
}

.KikiQuick__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 12px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
  background: var(--kiki-color-panel);
  border: 1px solid var(--kiki-color-hairline-strong);
  border-radius: 7px;
  cursor: pointer;
  text-decoration: none;
  transition: color var(--kiki-transition), border-color var(--kiki-transition), background var(--kiki-transition);
}
.KikiQuick__btn:hover {
  color: var(--kiki-color-accent);
  border-color: var(--kiki-color-accent);
}

.KikiQuick__footer {
  text-align: center;
  padding-top: 8px;
}

.KikiQuick__more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  transition: transform var(--kiki-transition), color var(--kiki-transition);
}
.KikiQuick__more:hover {
  color: var(--vp-c-brand-2);
  transform: translateX(3px);
}
</style>
