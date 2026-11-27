# X launch thread (0.7.0, free-tier `<= 280` chars per post)

Production rules applied:
- **Free X account hard cap:** every post below is verified `<= 280` characters (both raw and t.co-weighted) and `>= 35` words so all 4 posts pass `lint_x_draft.py` OCR/cadence gates cleanly when extracted.
- **Post 1 (root):** attach the **35–48 s** `1920x1080` `30fps` `H.264 (yuv420p) +faststart` physical split-screen MP4 (`ffmpeg -map_metadata -1 -fflags +bitexact`; see [demo-storyboard.md](demo-storyboard.md), Storyboard A). **Zero external URLs, zero hashtags, zero emojis, zero engagement-bait pointers in Post 1.**
- **Reply 2:** publish **20–30 s after Post 1** with the GitHub link and the Multi-Model + Orthogonal Reviewer catch plate (`docs/public/shots/workbench/workbench-per-role-models.en.png`).

---

## Post 1 (Root — attach 35–48 s split-screen MP4, ZERO links)

Sent a fix from my 5G phone over a self-hosted E2EE relay; 38s later my home PC patched the file and woke a physical Android phone to tap through tests.

Electron 44 + 0ms pre-warmed TLS 1.3 pool.

Early 0.x trade-off: macOS dmg is still unsigned (Control-click -> Open).

---

## Reply 2 (Post 20–30 s after Post 1 — attach multi-model fleet / $0.04 review plate)

Per-role multi-vendor dispatch in one session: a strong model plans, a cheap model runs scoped edits, and a third vendor reviews the diff. On a recent pass, that $0.04 review caught an off-by-one bug before merge.

MIT (0.6.2 / 0.7.0): https://github.com/X-T-E-R/kiki

---

## Reply 3 (Long-session engineering + 60fps resident device panels)

Built for multi-week work: worker indexing opens 3GB+ sessions in under a second, compaction keeps >=99% KV-cache hits on 250k+ runs, and 60fps phone, desktop, and PVE panels stay resident (0ms re-open) with Human Takeover.

20 plugins: https://github.com/X-T-E-R/kiki-plugins

---

## Reply 4 (Markdown agents, Recipes, peer threads, install truth)

Each agent is a Markdown file you own; native models bind Recipes (5 MIT recipes live). Long-lived sessions talk via ThreadSend and @Thread. Win 0.7 setup bundles Git Bash and rg; Android runs remote or local Bionic Node.

https://github.com/X-T-E-R/kiki-recipes
