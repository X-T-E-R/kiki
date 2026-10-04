# Inputs and roles

A video request can carry several inputs, and each one says what it is *for*.
Getting the role wrong is the most common way a shot comes back unusable.

## The five roles

| Role | What it means | Typical use |
|---|---|---|
| `first_frame` | The shot starts here | image-to-video from a specific composition |
| `last_frame` | The shot ends here | a defined transition between two stills |
| `reference_image` | Look, style, or subject | keeping a character or a palette consistent |
| `reference_video` | Look or motion to follow | matching an existing clip's movement |
| `reference_audio` | Sound the shot should carry | syncing a clip to narration or music |

An input is `{ file_id }` for something already in this session, `{ path }` for
a file on disk, or `{ url }` for something the user pointed at. A narration file
produced earlier in the same conversation is normally a `file_id` — reusing it
avoids a second copy and keeps the two files in step.

## Combinations providers reject

Not every provider accepts every combination, and the rules are not
interchangeable between them. A first frame and a last frame are often mutually
exclusive with reference images on the same request. Reference audio frequently
requires a reference image or video to go with it.

These are provider constraints, so they are reported by the provider:
`media` → `capabilities` with the provider and model returns them in
`constraints`. Read that before assembling a multi-input shot, not after it
fails. When a constraint blocks the request the user described, say which
constraint and offer the nearest thing that is actually supported — do not
quietly drop one of the inputs and generate something else.

## Reference audio is not a voice switch

A `reference_audio` input carries sound *into* the shot. It does not make the
provider generate speech, and it does not substitute for a text-to-speech call.
If the user wants narration, that is a separate `kind: "tts"` request, and the
audio file it produces can then be used here.

## Local engines

A provider backed by an engine the user runs (a local ComfyUI, for example) can
only do what its workflow defines. The workflow's inputs and outputs are the
capability, and the provider package's own notes say which workflow it submits.
Ask for `capabilities` rather than assuming a video model is behind it.
