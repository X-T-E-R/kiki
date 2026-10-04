---
name: media-image
description: Use when the user wants an image generated or edited — a picture, illustration, cover, icon set, a change to part of an existing image, or several variations of one idea — through an installed media provider.
---

Generating an image is one call with a prompt and, often, a reference. The work
that makes it good is choosing what to send and checking what came back.

**Start here.** Call `generate` with `request.kind: "image"`. Send a `prompt`
that says what the picture is, not how a model should be talked to. Omit
`provider` and `model` unless the user named one or several providers are ready
and the user has not chosen — then ask rather than picking a paid one.

**Before an edit,** read `references/editing.md`. It covers reference images,
masks, and the difference between a reference and an edit.

**Before asking for several variations,** read `references/variations.md`. It
covers `count` and why a batch of one call is not a queue of N calls.

**Check the result.** `artifacts` carries `file_id` and `mime` for every
original. When the model accepts images, open the image and look at it before
reporting — composition, cropping, and text rendering are not visible in a
filename. `effective` records what the provider actually used, and `warnings`
records what it ignored or changed; if a `warnings` entry contradicts what the
user asked for, say so rather than presenting the result as satisfying the
request.

**When a request is not supported,** an explicit ask that the provider cannot do
— a mask it does not have, more references than it accepts — is refused or
reported before submission. Do not silently drop the mask, substitute a
nearest size, or deliver something else under the same description.

Provider-specific limits live in that provider's own notes, listed in
`media` → `capabilities` → `skill_refs` with the condition that applies. Read
only the entry for the provider you are actually calling. Model names and
available sizes come from the same call; do not recall them.
