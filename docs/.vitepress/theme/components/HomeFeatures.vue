<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

const { lang } = useData()
const isZh = computed(() => lang.value.startsWith('zh'))

interface Capability {
  badge: string
  title: string
  desc: string
  href: string
}

interface Feature {
  icon: string
  title: string
  desc: string
  href: string
}

const capabilities = computed<Capability[]>(() => isZh.value
  ? [
      {
        badge: '三端一体',
        title: '三端协同，共享 daemon',
        desc: '桌面 GUI、CLI/TUI 与本地 API 服务器共享同一个后台进程与会话状态，无缝切换交互界面。',
        href: '/zh/getting-started/installation',
      },
      {
        badge: '多 Agent',
        title: '多 Agent 协同与编排',
        desc: '支持主从 agent 树状派发与并行执行，每个子 agent 拥有独立执行上下文与生命周期。',
        href: '/zh/customization/agents',
      },
      {
        badge: '定制能力',
        title: '提示词字段精细可控',
        desc: '灵活定制系统提示词各组成字段、模型词汇映射与会话行为，打造契合自身业务的专属 agent。',
        href: '/zh/customization/prompt-fields',
      },
      {
        badge: '任务看板',
        title: '透明的执行流与任务状态',
        desc: '内置任务看板与状态追踪，清晰把控长期运行的工作流、子任务依赖与工具调用审查。',
        href: '/zh/guides/sessions',
      },
      {
        badge: '扩展生态',
        title: 'MCP 协议与 Skills 生态',
        desc: '深度支持 Model Context Protocol 与团队自定义 Skills，灵活连通外部工具与各类企业数据源。',
        href: '/zh/server/mcp',
      },
      {
        badge: '极速响应',
        title: '高性能原生运行时',
        desc: '轻量资源占用、秒级冷启动与流式响应，为日常高频、长时间编码与深度会话精心打磨。',
        href: '/zh/server/local-server',
      },
    ]
  : [
      {
        badge: 'Tri-Form',
        title: 'Three Clients, One Daemon',
        desc: 'Desktop GUI, CLI/TUI, and local API server share the same daemon process and unified session state.',
        href: '/en/getting-started/installation',
      },
      {
        badge: 'Multi-Agent',
        title: 'Multi-Agent Orchestration',
        desc: 'Hierarchical subagent delegation and parallel tasks, each with its own isolated execution context.',
        href: '/en/customization/agents',
      },
      {
        badge: 'Customization',
        title: 'Customizable Prompt Fields',
        desc: 'Tailor system prompt segments, model vocabulary mappings, and session behaviors to your workflow.',
        href: '/en/customization/prompt-fields',
      },
      {
        badge: 'Task Board',
        title: 'Transparent Task Tracking',
        desc: 'Inspect multi-step execution flows, dependencies, and tool approval checkpoints in real time.',
        href: '/en/guides/sessions',
      },
      {
        badge: 'Ecosystem',
        title: 'MCP Protocol & Agent Skills',
        desc: 'Connect to external tools, databases, and enterprise data sources via Model Context Protocol and Skills.',
        href: '/en/server/mcp',
      },
      {
        badge: 'Performance',
        title: 'High-Performance Runtime',
        desc: 'Lightweight resource footprint, instant cold startup, and low-latency streaming for all-day focus.',
        href: '/en/server/local-server',
      },
    ])

const sectionTitle = computed(() => isZh.value ? '核心产品特性' : 'Product Capabilities')
const sectionLede = computed(() => isZh.value
  ? '专为高复杂度工程与人机协作设计的交互式通用 AI agent。'
  : 'An interactive general AI agent engineered for complex development and human-agent pairing.')

const ctaText = computed(() => isZh.value ? '查看文档' : 'Explore doc')
</script>

<template>
  <section class="KikiHome__section KikiFeatures">
    <h2 class="KikiHome__sectionTitle">{{ sectionTitle }}</h2>
    <p class="KikiHome__sectionLede">{{ sectionLede }}</p>
    <div class="KikiFeatures__grid">
      <a
        v-for="cap in capabilities"
        :key="cap.title"
        class="KikiFeatures__card"
        :href="withBase(cap.href)"
      >
        <div class="KikiFeatures__badge">{{ cap.badge }}</div>
        <h3 class="KikiFeatures__title">{{ cap.title }}</h3>
        <p class="KikiFeatures__desc">{{ cap.desc }}</p>
        <span class="KikiFeatures__cta">
          {{ ctaText }}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </a>
    </div>
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
    grid-template-columns: 1fr;
  }
}

.KikiFeatures__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
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

.KikiFeatures__badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: var(--kiki-radius-chip);
  background: var(--kiki-color-accent-soft);
  color: var(--kiki-color-accent-deep);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin-bottom: 16px;
  border: 1px solid rgba(232, 89, 12, 0.16);
}
:global(.dark) .KikiFeatures__badge {
  background: var(--kiki-color-accent-soft);
  color: var(--kiki-color-accent);
  border-color: rgba(255, 131, 64, 0.24);
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

.KikiFeatures__cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  margin-top: auto;
  transition: transform var(--kiki-transition);
}

.KikiFeatures__card:hover .KikiFeatures__cta {
  transform: translateX(3px);
}
</style>
