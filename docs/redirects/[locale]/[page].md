---
layout: page
search: false
head:
  - - meta
    - name: robots
      content: noindex
---

<!-- @content -->

<script setup>
import { onMounted } from 'vue'
import { useData, withBase } from 'vitepress'

const { params } = useData()

onMounted(() => {
  const target = new URL(withBase(params.value.target), window.location.origin)
  target.search = window.location.search
  target.hash = params.value.anchors[window.location.hash] ?? window.location.hash
  window.location.replace(target.href)
})
</script>
