<script setup lang="ts">
import { withBase } from 'vitepress'

withDefaults(defineProps<{ size?: number }>(), { size: 56 })
</script>

<template>
  <img
    class="KikiLogo"
    :src="withBase('/kiki-logo.svg')"
    :width="size"
    :height="size"
    alt="Kiki"
  />
</template>

<style scoped>
.KikiLogo {
  display: block;
  object-fit: contain;
  border-radius: 14px;
}
</style>
