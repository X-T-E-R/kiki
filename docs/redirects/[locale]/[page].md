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
  const mapped = params.value.anchors[window.location.hash]
  if (mapped?.startsWith('/')) {
    const destination = new URL(withBase(mapped), window.location.origin)
    destination.search = window.location.search
    window.location.replace(destination.href)
    return
  }
  const target = new URL(withBase(params.value.target), window.location.origin)
  target.search = window.location.search
  target.hash = mapped ?? window.location.hash
  window.location.replace(target.href)
})
</script>
