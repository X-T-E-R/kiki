---
name: media-tts
description: Use when the user wants speech, narration, a voice line, a read-aloud, or subtitles generated from text — including picking a voice or a language for a provider they have installed.
---

Speech is a voice, a language, and a text. Choosing the voice is the part that
needs care; the call itself is short.

**Start here.** Call `generate` with `request.kind: "tts"` and the `text` the
user wants spoken. A `voice` is required, and its value is a provider's own
identifier.

**Do not guess a voice id.** A provider can have hundreds, they are named by
that provider, and an invented id is a failed request. Call `media` →
`voices` with the `provider` first; add `language` to narrow it. The result is
paged — request more only when the user needs to browse further.

**Before choosing for the user,** read `references/choosing-a-voice.md`. It
covers what a voice list does and does not tell you, and why a language tag is
a hint rather than a guarantee.

**Language and text.** Write the text in the language it is to be spoken in.
`language` is a hint about the intended language, not a translation request and
not a switch that changes the words. A provider maps it to its own naming; the
mapping is reported back in `effective.language`.

**Before promising subtitles,** read `references/subtitles.md`. Subtitles are
an optional by-product, they are delivered as a separate artifact, and they can
fail while the audio succeeds.

**Check the result.** The audio original arrives with `file_id` and `mime`, and
it is playable in place. When the provider reports a duration, that is measured;
when it does not, do not estimate one for the user.

If the user asked for AI speech to be disclosed to an audience, say so in the
result — several providers require it, and it is a line in the delivery, not an
extra approval step.
