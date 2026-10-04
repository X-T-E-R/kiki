---
name: media-video
description: Use when the user wants a video generated or edited — a shot from a prompt, an image turned into motion, a clip with a specific camera move, or a video built from narration and references.
---

Video generation is a long job that usually runs after the turn ends. Plan for
that: the user gets a background task and a notification, not a file in the
next breath.

**Start here.** Call `generate` with `request.kind: "video"`. Pass
`execution: "background"` for anything the user described as long, or leave the
default for a short one that may finish inside the wait. The job comes back with
a `job_id`; a background job also has a `task_id`, and the task's completion
notification is how the user learns it finished.

**Before assembling a shot,** read `references/inputs-and-roles.md`. It covers
the five input roles, which combinations providers reject, and why reference
audio is not a "generate the voice" switch.

**Before promising a length, ratio, or resolution,** read `references/parameters.md` before composing the request. The set a model accepts is the model's, it changes, and `media` → `capabilities` is where the current set is. Do not recall model names or duration ranges.

**Do not resubmit.** A job that came back `unknown` may have been accepted and
charged. `media` → `resume` continues polling and downloading an existing remote
handle; it never buys a second generation. A new generation is a new
`generate` call with a new `request_id`, and it is a new bill — which is the
user's decision, not yours.

**Stopping is local.** `media` → `cancel` stops this session's waiting and
receiving. Whether the provider also stopped is reported separately, and
`unsupported` means the provider has no cancel path at all: the remote job may
still be running and charging. Report that as it is.

**When it finishes,** the artifacts carry `file_id` and `mime`. Report what
came back, and check `effective` for the duration and resolution the provider
actually used rather than the ones that were requested.
