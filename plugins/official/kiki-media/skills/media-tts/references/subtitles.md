# Subtitles and other by-products

## They are separate artifacts, and they can fail on their own

A provider may return a subtitle file alongside the audio, as a second artifact
with `role: "subtitle"`. It is not embedded in the audio and it is not part of
the audio's success.

A job can therefore finish `partial`: the audio landed, the subtitle did not.
That is the normal shape of that outcome, and the finished audio is still the
user's. Report the audio, say the subtitle did not come back, and do not
regenerate the audio to chase the subtitle — that is a second bill for a
by-product.

## Formats and timing

Subtitles arrive as a file, most often SRT, in whatever unit the provider used
with its own convention. Keep the file as it arrived. Re-timing it against the
audio is a separate job, and guessing at timings produces a subtitle that is
plausible and wrong.

## Only request them when the provider offers them

Subtitle support is a per-provider and sometimes per-model capability, not
something `generate` will add on request. `media` → `capabilities` for the
provider and model is where that is answered. If the provider does not offer
subtitles, say so rather than sending an option that will be ignored —
a silently dropped option is a request the user did not get.

## Long text

Providers cap how much text one request accepts, and the cap differs. Rather
than discovering it by hitting the limit, check `capabilities` when the text is
long.

If the text has to be split across several calls, that is several billed
requests. Say so and let the user decide, rather than splitting silently and
presenting the result as one narration.
