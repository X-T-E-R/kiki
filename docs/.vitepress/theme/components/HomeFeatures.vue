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
        badge: '工作台',
        title: '一个工作台，好几条线',
        desc: '主会话派子智能体，每个角色跑你为它选定的模型；耗时命令丢进后台，跑完自动回报。',
        href: '/zh/features/workbench',
      },
      {
        badge: '能复用的智能体',
        title: 'Agent Profiles',
        desc: '一份 Markdown 描述一类智能体：跑哪个模型、怎么指示、能用哪些工具、能派发谁，写一次到处复用。',
        href: '/zh/features/agents',
      },
      {
        badge: '长时间的活',
        title: '长时间的活',
        desc: '跨轮次推进的目标、你忙时排的队、定时提示词、每工作区一块任务看板，以及比会话活得更久的记忆。',
        href: '/zh/features/long-work',
      },
      {
        badge: '角色',
        title: '能一起干活的人',
        desc: '角色是长期身份：有自己的记忆、固定的日常对话入口，还能进房间和别的角色一起讨论同一个话题。',
        href: '/zh/features/people',
      },
      {
        badge: '数据与机器',
        title: '数据与机器都在你手上',
        desc: '各自带凭据的空间、有方向的远端连接、单向 thread bridge、Web 访问，以及会话内 SSH。',
        href: '/zh/features/spaces',
      },
      {
        badge: '掌控',
        title: '每一层都归你',
        desc: '提示词细到单个工具描述，连接和 OAuth 一张列表，权限模式你定，hooks 跑你自己的脚本。',
        href: '/zh/features/freedom',
      },
      {
        badge: '带过来，也接得进外面',
        title: '带过来，也接得进外面',
        desc: '把别的工具的对话导进来接着做，在编辑器里通过 ACP 用 Kiki，或者让 Kiki 把外部 harness 当引擎。',
        href: '/zh/features/ecosystem',
      },
    ]
  : [
      {
        badge: 'Workbench',
        title: 'One workbench, many lines',
        desc: 'A lead session dispatches subagents, each role runs the model you picked for it, and long commands go to the background and report back.',
        href: '/en/features/workbench',
      },
      {
        badge: 'Reusable agents',
        title: 'Agent Profiles',
        desc: 'One Markdown file describes a kind of agent: the model it runs on, how it is instructed, which tools it may call, and what it can dispatch.',
        href: '/en/features/agents',
      },
      {
        badge: 'Long work',
        title: 'Work that keeps going',
        desc: 'Goals that carry across turns, the queue for what you type while it works, scheduled prompts, a board per workspace, and memory that outlives the session.',
        href: '/en/features/long-work',
      },
      {
        badge: 'People',
        title: 'Roles you can talk to',
        desc: 'A persona is a long-term identity with its own memory and a fixed daily entry, and it can join a room to discuss a topic with other personas.',
        href: '/en/features/people',
      },
      {
        badge: 'Data & machines',
        title: 'Your data, your machines',
        desc: 'Spaces that carry their own credentials, directed remote connections, one-way thread bridges, Web access, and in-session SSH.',
        href: '/en/features/spaces',
      },
      {
        badge: 'Freedom',
        title: 'Every layer is yours',
        desc: 'Prompts are editable down to one tool description, connections and OAuth are one list, permission modes are yours to pick, and hooks run your scripts.',
        href: '/en/features/freedom',
      },
      {
        badge: 'Ecosystem',
        title: 'Bring your history, meet other tools',
        desc: 'Import another tool\'s history and keep working in it, drive Kiki from an editor over ACP, or let Kiki use an external harness as an engine.',
        href: '/en/features/ecosystem',
      },
    ])

const sectionTitle = computed(() => isZh.value ? '功能介绍' : 'Features')
const sectionLede = computed(() => isZh.value
  ? '每页讲清一个主题：工作台怎么分派、长活怎么持续、每天怎么用、能和谁一起干活、数据和机器在哪、哪一层归你，以及怎么接进别的工具。'
  : 'One topic per page: how the workbench dispatches work, how long work keeps going, what the daily window looks like, who you can talk to, where your data and machines are, which layers you control, and how other tools plug in.')

const ctaText = computed(() => isZh.value ? '看看它能做什么' : 'See what it does')
const allHref = computed(() => isZh.value ? '/zh/features/index' : '/en/features/index')
const allText = computed(() => isZh.value ? '全部功能' : 'All features')

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
