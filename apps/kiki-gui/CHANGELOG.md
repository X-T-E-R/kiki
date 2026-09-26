# @kiki/gui

## 0.1.4

### Patch Changes

- [`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Open built-in skills as read-only SKILL.md preview tabs using their embedded content instead of treating `builtin://` URIs as host files. File-backed skills still open from their real paths.

- [`67ae95b`](https://github.com/X-T-E-R/kiki/commit/67ae95b31c60a9acae61e53d6f418ff7ac7704fe) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Stop hidden agent tabs from replaying transcripts, reuse image previews, and paginate task lists.

- [`f9fc195`](https://github.com/X-T-E-R/kiki/commit/f9fc19500a8bef2c8f0569c0ec96c06190701cf6) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Agent capability tools now show enabled/total counts.

- [`2f797ce`](https://github.com/X-T-E-R/kiki/commit/2f797ce2029c8690780569caffb62a27929a1875) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Reject direct prompts for externally bound agents and route external subagent dialog messages through the durable mailbox.

- [`44a9cc7`](https://github.com/X-T-E-R/kiki/commit/44a9cc7fc3b62c823828499db0fe5bdc9f222192) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Redo the first-run onboarding wizard: three focused steps where every Next saves the current step, Test connection probes the unsaved form values through kap-server's `POST /providers:probe` (falling back to a browser-direct fetch on older servers), and auto becomes the default permission mode for new GUI installs.

- [`50f0425`](https://github.com/X-T-E-R/kiki/commit/50f0425d17fbe99b6a9feeea42f84883928b7844) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Restore image and video previews for previously read local files in the conversation timeline.

- [`31a3d2e`](https://github.com/X-T-E-R/kiki/commit/31a3d2e725dfa9c378f8e9171297b4abceee7089) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Fix the desktop device-code sign-in open-verification action: route the
  "Open verification page" button through the host's openUrl channel (a new
  http(s)-only `open_external_url` Tauri command driving the system browser)
  instead of `window.open`, which the desktop webview silently rejects, and
  surface a blocked or failed open as a visible inline line on the card.

- [`4246b4a`](https://github.com/X-T-E-R/kiki/commit/4246b4a9f4efc30a04dab3a401ce22cb7f1ff3fc) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Widen pane resize handles to a 12px hit zone straddling the border, show
  active drag feedback, and restore double-click reset on the preview pane.

- [`f6a6bd8`](https://github.com/X-T-E-R/kiki/commit/f6a6bd8ca799c9f691afa073d3fbcbf30f93908f) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Fix the conversation timeline losing its end anchor mid-turn: during a
  streaming turn the last row grows from the 120px estimate to its real height,
  the virtualizer's re-measure rule skipped the scrollTop compensation for a row
  that spans the fold, and its virtual wasAtEnd gate read the stale estimate —
  so the viewport stopped following the first time it rested below a growing
  block. Every later append (the next user bubble included) then drew below the
  fold, with stale position-fix paints floating the user bubble over the
  assistant content above it. Transcript now re-asserts "truly at end" from the
  actual DOM distance (scrollHeight − clientHeight − scrollTop) through the
  virtualizer's shouldAdjustScrollPositionOnItemSizeChange, so the compensation
  runs while the viewport is still anchored and follow survives the estimate→
  actual delta. Default above-fold and backward-scroll rules are untouched.

- [`001f73c`](https://github.com/X-T-E-R/kiki/commit/001f73ca77315374366b8b521871cca70d8087e5) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Keep unsent timeline annotations when switching between conversations.

- [`f9fc195`](https://github.com/X-T-E-R/kiki/commit/f9fc19500a8bef2c8f0569c0ec96c06190701cf6) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Annotations added to an already-rendered message now show their highlight and bubble.

- [`4ba5d77`](https://github.com/X-T-E-R/kiki/commit/4ba5d77b9eebe83fa5f01bdc2ee63b3cab8e092b) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Label peer-thread messages with their source thread in the receiving context and the timeline bubble.

- [`cea9855`](https://github.com/X-T-E-R/kiki/commit/cea98554aaf8e590ae0a92901e688f26ee2b8161) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Correct the auto and yolo permission hints and treat an empty default model as unset.

- [`f9fc195`](https://github.com/X-T-E-R/kiki/commit/f9fc19500a8bef2c8f0569c0ec96c06190701cf6) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Show message totals when sessions open and restore historical subagent terminal details without unknown tool-count badges.

- [`57bf267`](https://github.com/X-T-E-R/kiki/commit/57bf267bcbd28aaad2e26445255a75261dfec5bc) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Batch composer draft saves and reduce GUI rendering work in long sessions.

- [`f9fc195`](https://github.com/X-T-E-R/kiki/commit/f9fc19500a8bef2c8f0569c0ec96c06190701cf6) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Share one right rail between the main agent and subagent views, with an owner badge showing whose panel it is.

- [`b1efab1`](https://github.com/X-T-E-R/kiki/commit/b1efab174ad703bbb31f6e845609e46faccc3389) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Default composer sends with Ctrl/Cmd+Enter and route every external URL through the system browser.

- [`a36ca0d`](https://github.com/X-T-E-R/kiki/commit/a36ca0dc3acf2f22729f817ec20bd7650f3f055b) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Fold-steps toggle now applies instantly, folded step groups refresh when a member's state changes, and expanded groups keep the original step order.

- [`dafce3c`](https://github.com/X-T-E-R/kiki/commit/dafce3c71959d93b3c71bf9a84346d044adc0e19) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Move the fold-steps switch into the Composer settings card so the General section fits one 1280×800 screen again.

- Updated dependencies [[`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca), [`44a9cc7`](https://github.com/X-T-E-R/kiki/commit/44a9cc7fc3b62c823828499db0fe5bdc9f222192), [`50f0425`](https://github.com/X-T-E-R/kiki/commit/50f0425d17fbe99b6a9feeea42f84883928b7844), [`05e33fe`](https://github.com/X-T-E-R/kiki/commit/05e33fe90c5b330ae2925236d7355fb4b613bd8a), [`e341a61`](https://github.com/X-T-E-R/kiki/commit/e341a61db26f03a789dc76c98973b5e162b307e1), [`cea9855`](https://github.com/X-T-E-R/kiki/commit/cea98554aaf8e590ae0a92901e688f26ee2b8161), [`57bf267`](https://github.com/X-T-E-R/kiki/commit/57bf267bcbd28aaad2e26445255a75261dfec5bc), [`8d0a94a`](https://github.com/X-T-E-R/kiki/commit/8d0a94a926e9d8bba01b9f400871642ca1383940), [`b1efab1`](https://github.com/X-T-E-R/kiki/commit/b1efab174ad703bbb31f6e845609e46faccc3389), [`a36ca0d`](https://github.com/X-T-E-R/kiki/commit/a36ca0dc3acf2f22729f817ec20bd7650f3f055b), [`dafce3c`](https://github.com/X-T-E-R/kiki/commit/dafce3c71959d93b3c71bf9a84346d044adc0e19)]:
  - @kiki/klient@0.1.3
  - @kiki/protocol@0.5.1
  - @kiki/session-core@0.0.2
