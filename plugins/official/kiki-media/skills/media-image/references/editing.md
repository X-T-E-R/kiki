# Editing an image

An edit and a generation are the same call; what changes is what you send.

## Deciding reference vs. edit

A **reference image** tells the model what the result should look like — style,
material, character, palette. The model produces something new from it. Send it
in `images`.

An **edit** changes a specific part of a specific image. Two shapes:

- **With a mask** — send the image in `images` and the region in `mask`. The
  mask defines where the change applies. Mask polarity is the provider's own
  convention and not all providers support masks at all; check `capabilities`
  before promising one.
- **Without a mask** — describe the change in the prompt and send the image as a
  reference. The model decides what to alter. This is the reliable default
  when the provider has no mask support, and the honest one to tell the user
  about: "everything not named in the prompt may shift."

Say which of these you did when you report. A user who expected a local repair
and got a re-render of the whole frame needs to know that from the first
sentence, not from comparing pixels.

## What a reference cannot carry

Providers differ in how many reference images they accept, in whether they
accept several at once, and in whether a reference is used for appearance,
composition, or identity. `media` → `capabilities` with the provider and model
answers all three. The `constraints` list in that answer is where a provider
states its own limits, including the ones that will reject a request outright.

Do not pad `images` to reach a count. Sending five references to a provider
that uses the first does not make it better; it makes the result depend on a
detail you cannot see.

## Input references

An input is `{ file_id }` for something already in this session, `{ path }` for
a file on disk, or `{ url }` for something the user pointed at. Prefer
`file_id` when the file is already here — a file the conversation produced is
usually the best input for the next step, and it avoids a second copy.

## After the edit

Look at the result before reporting it. Edits fail in ways a filename does not
show: the change landed somewhere else, the untouched region drifted, text in
the region came out misspelled, or the mask edge is visible. If the provider
reports `effective` values that differ from what you asked for, they are part of
the answer.
